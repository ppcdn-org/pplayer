// Playout buffer length is a purely local playback-side knob: it tells the
// browser's jitter buffer how many milliseconds of media to hold before
// rendering, trading latency for resilience to network jitter. ppcenter is
// not involved — there's nothing to negotiate, so this never goes into the
// /v1/play/requests body, only into the RTCRtpReceiver once a track exists
// (see playback-paths.mjs).
export const MIN_BUFFER_MS = 100;
export const MAX_BUFFER_MS = 1000;

// Used when no buffer length was requested explicitly. Setting this at all
// opts out of the browser's own continuously-adapting jitter buffer, so the
// default is deliberately on the generous side: 200ms rides out ordinary
// jitter while staying well under the ~500ms race window the P2P/Edge
// controller works with.
export const DEFAULT_BUFFER_MS = 200;

// parseBufferMs reads the raw "bufferMs" query value and clamps it into the
// supported [100, 1000] range. Missing/invalid input returns null rather than
// silently substituting a guessed default — callers that care about "was a
// buffer length requested at all" (e.g. deciding whether to touch
// playoutDelayHint and override the browser's own adaptive default) need to
// tell that apart from "requested 100 and got clamped to 100".
export function parseBufferMs(rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') return null;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return null;
    return clampBufferMs(parsed);
}

export function clampBufferMs(ms) {
    return Math.min(MAX_BUFFER_MS, Math.max(MIN_BUFFER_MS, ms));
}

// playoutDelayHint (RTCRtpReceiver) is expressed in seconds, not ms.
export function bufferMsToPlayoutDelaySeconds(bufferMs) {
    return bufferMs / 1000;
}

// applyPlayoutBuffer pushes bufferMs onto every receiver on pc and reports
// which API actually accepted it, so a caller can tell "applied" apart from
// "this browser ignores the knob entirely" instead of assuming it worked.
//
// Two APIs exist, tried in this order:
//   - jitterBufferTarget: the standardized one (WebRTC Extensions), in ms.
//   - playoutDelayHint: Chrome's older non-standard property, in seconds.
// Chromium-based browsers support at least one; browsers that expose
// neither keep their own adaptive buffer and this returns null. Returns
// null too when pc has no receivers yet - tracks arrive asynchronously, so
// callers apply this on the track event rather than right after connecting.
export function applyPlayoutBuffer(pc, bufferMs) {
    if (!pc || typeof pc.getReceivers !== 'function') return null;
    const clamped = clampBufferMs(bufferMs);
    let usedStandard = false;
    let usedLegacy = false;
    for (const receiver of pc.getReceivers()) {
        if (!receiver) continue;
        if ('jitterBufferTarget' in receiver) {
            receiver.jitterBufferTarget = clamped;
            usedStandard = true;
        } else if ('playoutDelayHint' in receiver) {
            receiver.playoutDelayHint = bufferMsToPlayoutDelaySeconds(clamped);
            usedLegacy = true;
        }
    }
    if (usedStandard) return 'jitterBufferTarget';
    if (usedLegacy) return 'playoutDelayHint';
    return null;
}
