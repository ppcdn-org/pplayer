// Live-edge catch-up: speeds video.playbackRate up slightly whenever the
// measured end-to-end delay (see main.js's lastP2PDelayMs/reportP2PDelay)
// sits above a target, and returns to normal speed once it drains back
// down. This is what actually pulls accumulated delay back down after a
// network hiccup or a slow start - lowering SRTLatency/DEFAULT_BUFFER_MS
// (see ppmmx's conf.go and buffer-config.mjs) only shrinks how much delay
// gets added going forward, it does nothing about delay that has already
// built up in a buffer.
//
// Deliberately playbackRate, not seeking or dropping frames: a small rate
// bump (1.03-1.08x) is inaudible on the pitch-corrected audio track modern
// browsers already apply by default (HTMLMediaElement.preservesPitch), and
// it drains the buffer smoothly over several seconds instead of a visible
// jump/stutter.

// Hysteresis band: only speed up once delay exceeds target+HIGH, only
// return to 1.0x once it drops back under target+LOW. The gap between the
// two stops the controller from flapping rate right at a single threshold
// when delay hovers near it.
export const DEFAULT_TARGET_MS = 500;
const HIGH_MARGIN_MS = 150; // engage catch-up above target+150ms
const LOW_MARGIN_MS = 50; // disengage below target+50ms
const CATCHUP_RATE = 1.05;
const NORMAL_RATE = 1.0;

// A delay reading over this far above target would need several minutes of
// 1.05x to drain - almost certainly a stale/misdetected value (e.g. right
// after a reconnect) rather than something worth chasing at a barely
// perceptible rate. Leave it to buffering/reconnect logic instead of
// running hot indefinitely.
const MAX_CHASEABLE_EXCESS_MS = 5000;

export class CatchUpController {
    constructor(video, { targetMs = DEFAULT_TARGET_MS } = {}) {
        this.video = video;
        this.targetMs = targetMs;
        this.catchingUp = false;
        this.enabled = true;
    }

    setTargetMs(targetMs) {
        this.targetMs = targetMs;
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) this._setRate(NORMAL_RATE);
    }

    // Called once a second from main.js's updateStats() with the same
    // delayMs it displays as P2P Delay. Pass null/undefined when no fresh,
    // plausible reading exists (e.g. clock not yet calibrated) - the
    // controller holds its last rate rather than guessing.
    update(delayMs) {
        if (!this.enabled || delayMs === null || delayMs === undefined || !Number.isFinite(delayMs)) return;

        // Only safe to change rate while media is actually advancing.
        // readyState < 2 (HAVE_CURRENT_DATA) or an explicit pause/seek means
        // the browser is already stalled/not rendering - forcing playbackRate
        // here doesn't help and fights whatever recovery it's doing on its
        // own once it resumes.
        if (this.video.paused || this.video.seeking || this.video.readyState < 2) {
            this._setRate(NORMAL_RATE);
            return;
        }

        const excess = delayMs - this.targetMs;

        if (excess > MAX_CHASEABLE_EXCESS_MS) {
            this._setRate(NORMAL_RATE);
            return;
        }

        if (!this.catchingUp && excess > HIGH_MARGIN_MS) {
            this._setRate(CATCHUP_RATE);
        } else if (this.catchingUp && excess < LOW_MARGIN_MS) {
            this._setRate(NORMAL_RATE);
        }
    }

    // Called on stopStream()/new session so a leftover 1.05x doesn't carry
    // into the next play click before the first update() tick corrects it.
    reset() {
        this._setRate(NORMAL_RATE);
    }

    _setRate(rate) {
        if (this.video.playbackRate !== rate) {
            this.video.playbackRate = rate;
        }
        this.catchingUp = rate !== NORMAL_RATE;
    }
}
