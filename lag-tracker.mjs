// Pull-side rebuffering (卡顿) tracker. A stall that lasts longer than the
// threshold counts as one lag event, and its full duration is added to the
// running lag total. main.js reports the totals on the viewer session
// (start/heartbeat/stop), ppcenter stores them on play_sessions, and the
// hourly aggregator derives a rebuffering rate = lagDuration / watchedDuration.
//
// A stall is driven by the <video> element's waiting/playing events: waiting
// fires when playback cannot advance because data is not available, playing
// when it resumes. A brief renegotiation or ABR layer switch also reads as
// waiting for a tick or two, which is exactly why sub-threshold stalls are
// dropped instead of counted.

export const DEFAULT_LAG_THRESHOLD_MS = 2000;

export class LagTracker {
    constructor({ thresholdMs = DEFAULT_LAG_THRESHOLD_MS } = {}) {
        this.thresholdMs = thresholdMs;
        this.count = 0;
        this.durationMs = 0;
        this.stalledSince = null;
    }

    // Called when playback is expected to be advancing but is not.
    beginStall(nowMs = Date.now()) {
        if (this.stalledSince === null) this.stalledSince = nowMs;
    }

    // Called when playback resumes. Returns true when this stall was counted
    // as a lag event (its duration exceeded the threshold).
    endStall(nowMs = Date.now()) {
        if (this.stalledSince === null) return false;
        const duration = nowMs - this.stalledSince;
        this.stalledSince = null;
        if (duration <= this.thresholdMs) return false;
        this.count++;
        this.durationMs += duration;
        return true;
    }

    // Drop an in-progress stall without counting it (user pause/seek, teardown).
    cancelStall() {
        this.stalledSince = null;
    }

    reset() {
        this.count = 0;
        this.durationMs = 0;
        this.stalledSince = null;
    }
}
