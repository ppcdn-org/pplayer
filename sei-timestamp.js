'use strict';

// Reads the OBS abs-timestamp SEI (see docs/obs-abs-timestamp-protocol.md
// in the OBS repo) directly out of the received H.264/H.265 bitstream via
// WebCodecs Insertable Streams (RTCRtpReceiver.createEncodedStreams()).
//
// Unlike the "obs-timestamp" DataChannel relay (see mmxplayer.js /
// obs_timestamp_broadcast.go), the SEI travels inside the encoded frame
// itself, so it survives mmx-to-mmx cascading (origin -> edge -> ...)
// without any server-side relay code: mmx's WHIP/WHEP path is pure RTP
// passthrough (UseRTPPackets: true end to end), and the ABR track
// selector's remuxer only strips SPS/PPS/AUD, never SEI. It's also
// inherently correct for whichever simulcast layer is currently being
// decoded - no rid matching needed, since these are the frames the browser
// is actually about to decode.
//
// HEVC/H264 multitrack (see
// docs/design/whip-hevc-h264-multitrack-simulcast-design.zh-CN.md): ppobs
// embeds the identical SEI payload in both codecs' bitstreams (see
// abs-ts.h in the OBS repo, which SEI-injects every packet_callback
// regardless of which WHIP session it belongs to), so only the NAL
// container format differs between the two - see findObsAbsTimestamp's
// `codec` parameter.
//
// Chromium-only (createEncodedStreams requires the PeerConnection to be
// constructed with { encodedInsertableStreams: true }, see mmxplayer.js);
// on browsers without it, attachSeiTimestampReader() is a no-op returning
// false, and the caller should keep relying on the DataChannel relay.

const OBS_ABS_TS_SEI_UUID = new Uint8Array([
    0x4F, 0x42, 0x53, 0x2D, 0x41, 0x42, 0x53, 0x54, // "OBS-ABST"
    0x53, 0x2D, 0x53, 0x45, 0x49, 0x2D, 0x76, 0x31, // "S-SEI-v1"
]);

function bytesEqualAt(data, offset, needle) {
    if (offset + needle.length > data.length) return false;
    for (let i = 0; i < needle.length; i++) {
        if (data[offset + i] !== needle[i]) return false;
    }
    return true;
}

// Removes H.264 emulation-prevention bytes (00 00 03 -> 00 00) from a NAL's
// raw bytes, needed before interpreting SEI payload type/size/content:
// escaping is part of RBSP encoding itself, independent of Annex-B framing.
function unescapeRBSP(nal) {
    const out = new Uint8Array(nal.length);
    let o = 0;
    let zeroRun = 0;
    for (let i = 0; i < nal.length; i++) {
        const b = nal[i];
        if (zeroRun >= 2 && b === 0x03 && i + 1 < nal.length && nal[i + 1] <= 0x03) {
            zeroRun = 0;
            continue; // drop emulation_prevention_three_byte
        }
        out[o++] = b;
        zeroRun = (b === 0) ? zeroRun + 1 : 0;
    }
    return out.subarray(0, o);
}

// Finds Annex-B start codes (00 00 01 / 00 00 00 01) in `data` and returns
// the byte range of each NAL (header + RBSP, excluding the start code).
function* iterateAnnexBNALs(data) {
    const len = data.length;
    let i = 0;
    let nalStart = -1;
    while (i + 2 < len) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
            if (nalStart >= 0) yield data.subarray(nalStart, i);
            nalStart = i + 3;
            i += 3;
            continue;
        }
        i++;
    }
    if (nalStart >= 0 && nalStart < len) yield data.subarray(nalStart, len);
}

// NAL unit type and header length for each codec's Annex-B framing. H.264's
// header is one byte (nal_unit_type in bits 0-4); H.265/HEVC's is two bytes
// (nal_unit_type in bits 1-6 of the first byte - see Rec. ITU-T H.265
// §7.3.1.2). Both codecs' SEI *message* syntax (payloadType/payloadSize/
// payload, Rec. ITU-T H.264|H.265 Annex D.1) is identical, so only NAL
// header parsing needs to branch.
const NAL_KIND_H264_SEI = 6;
const NAL_KIND_HEVC_SEI_PREFIX = 39;
const NAL_KIND_HEVC_SEI_SUFFIX = 40;

function parseNalHeader(codec, firstByte) {
    if (codec === 'hevc') {
        return { type: (firstByte >> 1) & 0x3F, headerLen: 2 };
    }
    return { type: firstByte & 0x1F, headerLen: 1 };
}

function isSeiNal(codec, nalType) {
    if (codec === 'hevc') return nalType === NAL_KIND_HEVC_SEI_PREFIX || nalType === NAL_KIND_HEVC_SEI_SUFFIX;
    return nalType === NAL_KIND_H264_SEI;
}

// Scans one encoded H.264/H.265 access unit for a user_data_unregistered
// SEI NAL (payload type 5) carrying the OBS abs-timestamp UUID, returning
// the embedded timestamp_ms (see protocol doc section 2), or null if
// absent. `codec` is 'h264' (default) or 'hevc' - see the NAL_KIND_*
// constants above for why the two need different header parsing.
function findObsAbsTimestamp(data, codec) {
    for (const rawNal of iterateAnnexBNALs(data)) {
        if (rawNal.length < 2) continue;
        // strip trailing zero-padding some encoders leave before the next start code
        let end = rawNal.length;
        while (end > 0 && rawNal[end - 1] === 0) end--;
        if (end < 2) continue;

        const { type: nalType, headerLen } = parseNalHeader(codec, rawNal[0]);
        if (!isSeiNal(codec, nalType)) continue;
        if (end <= headerLen) continue;

        const nal = unescapeRBSP(rawNal.subarray(0, end));
        let p = headerLen; // skip the codec's NAL header

        let payloadType = 0;
        while (p < nal.length && nal[p] === 0xFF) { payloadType += 255; p++; }
        if (p >= nal.length) continue;
        payloadType += nal[p]; p++;

        let payloadSize = 0;
        while (p < nal.length && nal[p] === 0xFF) { payloadSize += 255; p++; }
        if (p >= nal.length) continue;
        payloadSize += nal[p]; p++;

        if (payloadType !== 5 || payloadSize < 24 || p + 24 > nal.length) continue;
        if (!bytesEqualAt(nal, p, OBS_ABS_TS_SEI_UUID)) continue;

        let ts = 0;
        for (let k = 0; k < 8; k++) {
            ts = ts * 256 + nal[p + 16 + k];
        }
        return ts;
    }
    return null;
}

// Attaches an Insertable Streams passthrough transform to a video
// RTCRtpReceiver: every encoded frame is scanned for the OBS abs-timestamp
// SEI and, if found, reported via onTimestamp(timestampMs); frames are
// always forwarded unmodified. Returns false (no-op) if this browser
// doesn't support createEncodedStreams. `codec` is 'h264' (default) or
// 'hevc' - the caller knows which WHEP session (".../h264/whep" vs
// ".../hevc/whep") this receiver's track came from and must pass the
// matching value, since the two codecs' NAL framing differs (see
// findObsAbsTimestamp above).
function attachSeiTimestampReader(receiver, onTimestamp, codec) {
    if (!receiver || typeof receiver.createEncodedStreams !== 'function') return false;

    const resolvedCodec = codec === 'hevc' ? 'hevc' : 'h264';

    let streams;
    try {
        streams = receiver.createEncodedStreams();
    } catch (e) {
        console.warn('[SEI] createEncodedStreams failed:', e && e.message);
        return false;
    }

    const transform = new TransformStream({
        transform(frame, controller) {
            try {
                const ts = findObsAbsTimestamp(new Uint8Array(frame.data), resolvedCodec);
                if (ts !== null) onTimestamp(ts);
            } catch (e) {
                // A parse error must never break playback - just skip this frame.
            }
            controller.enqueue(frame);
        }
    });

    streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch((e) => {
        console.warn('[SEI] insertable-streams pipeline error:', e && e.message);
    });

    return true;
}

window.attachSeiTimestampReader = attachSeiTimestampReader;
