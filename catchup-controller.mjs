// Live-edge catch-up: decides when the measured end-to-end delay (see
// main.js's lastP2PDelayMs/reportP2PDelay) has drifted far enough above a
// target that the player should actively drain it, rather than only shrinking
// how much delay gets added going forward (which is all lowering SRTLatency or
// the playout buffer does).
//
// This used to actuate through video.playbackRate, which does not work: the
// element's source is a MediaStream, and for a MediaStream the rate is
// ignored. Measured in Chromium - assigning 2.0 leaves playbackRate reading
// back as 1, and currentTime keeps advancing at exactly wall clock - so every
// "catching up 1.05x" this reported was cosmetic and no delay was ever
// drained. Seeking and frame-dropping are equally unavailable for the same
// reason: a live MediaStream has no seekable timeline to move within.
//
// The one lever a browser does expose is the jitter buffer's target delay
// (jitterBufferTarget / playoutDelayHint), so the controller no longer
// actuates anything itself: it decides, and the caller supplies an `onCatchUp`
// actuator that lowers the pinned playout buffer while catch-up is engaged and
// restores it afterwards. With no actuator - which is the default, because a
// browser left on its own adaptive jitter buffer already drains excess delay
// by itself (see buffer-config.mjs) - the controller reports itself
// unavailable instead of claiming to be catching up.

// Hysteresis band: only speed up once delay exceeds target+HIGH, only
// return to 1.0x once it drops back under target+LOW. The gap between the
// two stops the controller from flapping rate right at a single threshold
// when delay hovers near it.
export const DEFAULT_TARGET_MS = 500;
const HIGH_MARGIN_MS = 150; // engage catch-up above target+150ms
const LOW_MARGIN_MS = 50; // disengage below target+50ms

// A delay reading over this far above target would need several minutes of
// 1.05x to drain - almost certainly a stale/misdetected value (e.g. right
// after a reconnect) rather than something worth chasing at a barely
// perceptible rate. Leave it to buffering/reconnect logic instead of
// running hot indefinitely.
const MAX_CHASEABLE_EXCESS_MS = 5000;

export class CatchUpController {
    // onCatchUp(engaged) is the actuator: called only when the decision
    // changes, with true to start draining and false to stop. It must return
    // true from an engage call when it actually did something; anything else
    // means "nothing to drain right now" and leaves the controller
    // disengaged. Leave it unset and the controller is inert - see the module
    // comment for why that is the right default.
    constructor(video, { targetMs = DEFAULT_TARGET_MS, onCatchUp = null } = {}) {
        this.video = video;
        this.targetMs = targetMs;
        this.onCatchUp = onCatchUp;
        this.catchingUp = false;
        this.enabled = true;
    }

    setTargetMs(targetMs) {
        this.targetMs = targetMs;
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) this._setCatchUp(false);
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
            this._setCatchUp(false);
            return;
        }

        const excess = delayMs - this.targetMs;

        if (excess > MAX_CHASEABLE_EXCESS_MS) {
            this._setCatchUp(false);
            return;
        }

        if (!this.catchingUp && excess > HIGH_MARGIN_MS) {
            this._setCatchUp(true);
        } else if (this.catchingUp && excess < LOW_MARGIN_MS) {
            this._setCatchUp(false);
        }
    }

    // Called on stopStream()/new session so a leftover engaged state doesn't
    // carry into the next play click before the first update() tick corrects it.
    reset() {
        this._setCatchUp(false);
    }

    _setCatchUp(engaged) {
        if (this.catchingUp === engaged) return;

        if (engaged) {
            // Engage only once the actuator confirms it did something. An
            // absent or declining actuator must leave catchingUp false:
            // reporting a state with no effect behind it is exactly what the
            // playbackRate version did for its whole life.
            if (!this.onCatchUp || this.onCatchUp(true) !== true) return;
            this.catchingUp = true;
            return;
        }

        this.catchingUp = false;
        if (this.onCatchUp) this.onCatchUp(false);
    }
}
