// PLY-013: consume the absolute timestamp ppobs embeds per frame and turn it
// into an end-to-end delay, using the PLY-014-calibrated clock from
// time-sync.mjs instead of raw Date.now(). ppobs embeds the timestamp
// directly in the codec bitstream as a SEI (H.264/H.265) / metadata OBU
// (AV1) payload (ppobs/docs/obs-abs-timestamp-protocol.md §2) - this works
// uniformly across RTMP/ERTMP, SRT, and WHIP ingest since it's part of the
// bitstream itself, not a protocol-specific side channel.
//
// mmx extracts that SEI/OBU on whichever protocol the publisher used (see
// internal/servers/webrtc/sei_timestamp.go for WHIP, internal/protocols/rtmp
// and internal/protocols/mpegts's to_stream.go for RTMP/SRT) and
// re-broadcasts it to WHEP readers as a `{"type":"OBS_TIMESTAMP",
// "data":{"timestamp":<ms>}}` envelope over the same ABR control WebSocket
// ppplayer's MMXControlClient already opens (ppplayer.mjs), not a new
// channel. isValidObsTimestampMessage validates the already-JSON.parsed
// `data` object regardless of which ingest protocol produced it.
//
// Scope note: this only ever fires for the edge path today (SEI read via
// WebCodecs Insertable Streams - see sei-timestamp.js - covers the direct
// P2P PeerConnection case for Chromium browsers instead); the P2P path for
// other browsers relies on RTCP RTT (see docs/tech/P2P时延测量方案.md §4).

export function isValidObsTimestampMessage(msg) {
    return !!msg
        && typeof msg === 'object'
        && Number.isFinite(msg.timestamp)
        && msg.timestamp > 0;
}

// nowMs must already be offset-corrected (TimeSync#now()); passing the
// raw/uncorrected clock defeats the entire point of PLY-014 and is how the
// original proposal ended up with spurious negative delays. null in ⇒ null
// out: the caller must not report anything before calibration completes.
export function computeDelayMs(nowMs, timestampMs) {
    if (nowMs === null || nowMs === undefined) return null;
    if (!Number.isFinite(timestampMs)) return null;
    return nowMs - timestampMs;
}
