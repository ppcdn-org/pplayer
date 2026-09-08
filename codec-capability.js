'use strict';

// Browser HEVC playback capability detection - see
// docs/design/whip-hevc-h264-multitrack-simulcast-design.zh-CN.md §4.4.
//
// The result decides which of ppobs's two independent WHIP publish paths
// (".../h264/whep" or ".../hevc/whep") this player requests, so it must be
// resolved *before* the WHEP handshake starts - there's no ABR-style
// mid-stream codec switch, since the two codecs are on entirely separate
// WHIP/WHEP sessions server-side (see the design doc's §2.2).
//
// Detection is deliberately conservative: any failure, unsupported API, or
// inconclusive result falls back to H264, which every target browser can
// decode. HEVC is only selected when the browser affirmatively reports
// support.

// A single representative HEVC profile/level string is enough to answer
// "can this browser decode HEVC over WebRTC at all" - ppobs's HEVC
// Simulcast layers all share the same encoder/profile (see
// WHIPHevcEncoders.hpp in the ppobs repo), so per-resolution probing isn't
// needed here.
const HEVC_MEDIA_CAPABILITIES_CODEC = 'hvc1.1.6.L93.B0';
const HEVC_RTP_MIME_TYPES = ['video/H265', 'video/HEVC'];

// 1. navigator.mediaCapabilities.decodingInfo() - the standards-track API
// for "can this browser decode and smoothly play this codec". Asking for a
// WebRTC media type keeps the query aligned with how the frame will
// actually be delivered (over RTP, not a container demuxer).
async function hevcSupportedViaMediaCapabilities() {
    if (!navigator.mediaCapabilities || typeof navigator.mediaCapabilities.decodingInfo !== 'function') {
        return null; // API unavailable - caller tries the next method
    }
    try {
        const result = await navigator.mediaCapabilities.decodingInfo({
            type: 'webrtc',
            video: {
                contentType: `video/mp4; codecs="${HEVC_MEDIA_CAPABILITIES_CODEC}"`,
                width: 1920,
                height: 1080,
                bitrate: 3000000,
                framerate: 30,
            },
        });
        return !!(result && result.supported);
    } catch (e) {
        console.warn('[CodecCapability] mediaCapabilities.decodingInfo failed:', e && e.message);
        return null;
    }
}

// 2. RTCRtpReceiver.getCapabilities('video') - lists every codec the local
// WebRTC implementation can negotiate as a receiver, independent of the
// mediaCapabilities API's own (sometimes more conservative) judgment about
// "smooth" playback. Used as a fallback, per the design doc's suggested
// detection order.
function hevcSupportedViaRtpCapabilities() {
    if (typeof RTCRtpReceiver === 'undefined' || typeof RTCRtpReceiver.getCapabilities !== 'function') {
        return null;
    }
    try {
        const caps = RTCRtpReceiver.getCapabilities('video');
        if (!caps || !Array.isArray(caps.codecs)) return null;
        return caps.codecs.some((c) => HEVC_RTP_MIME_TYPES.includes(c.mimeType));
    } catch (e) {
        console.warn('[CodecCapability] RTCRtpReceiver.getCapabilities failed:', e && e.message);
        return null;
    }
}

// Cached across calls within a page load: capability doesn't change at
// runtime, and repeating the async mediaCapabilities probe on every
// (re)connect would just add latency to stream start for no benefit.
let cachedHevcSupport = null;

async function isHevcPlaybackSupported() {
    if (cachedHevcSupport !== null) return cachedHevcSupport;

    let supported = await hevcSupportedViaMediaCapabilities();
    if (supported === null) {
        supported = hevcSupportedViaRtpCapabilities();
    }
    // Inconclusive (both methods unavailable or threw) - not "detected
    // unsupported" but treated identically per the design doc: H264 is the
    // safe, always-available fallback.
    cachedHevcSupport = supported === true;
    console.log(`[CodecCapability] HEVC playback supported: ${cachedHevcSupport}`);
    return cachedHevcSupport;
}

// Public entry point matching the design doc's §4.4 sketch exactly.
async function selectPlaybackCodec() {
    return (await isHevcPlaybackSupported()) ? 'hevc' : 'h264';
}

window.isHevcPlaybackSupported = isHevcPlaybackSupported;
window.selectPlaybackCodec = selectPlaybackCodec;
