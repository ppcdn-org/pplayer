// Detects the "receiving bytes but decoding nothing" stall seen when the
// server-side forward path (Origin -> Edge -> this WHEP session) survives a
// publisher restart in a state where RTP keeps arriving but the browser's
// decoder never produces a frame (getStats() shows videoKbps > 0 while
// framesPerSecond stays 0 indefinitely - see the 2026-09-16 OBS
// stop/restart incident). WebRTC's own reconnect machinery (ICE restart,
// PeerConnection connectionState) doesn't catch this because the
// connection itself never drops - only the media pipeline downstream of it
// gets stuck.
//
// The fix that's actually been observed to work is exactly what a user
// clicking Start does: tear the whole session down and renegotiate from
// scratch. This module only decides *when* to do that automatically -
// startStream() is what main.js already runs on a manual click.

// Long enough that a real ABR layer switch or a brief renegotiation blip
// (which also reads fps=0 for a tick or two while the new track spins up)
// doesn't false-positive. Short enough that "keeps spinning for tens of
// seconds" doesn't happen unattended.
const DEFAULT_STALL_SECONDS = 8;

// How long after a stream starts (reset) the watchdog waits before it starts
// counting fps=0 toward a stall. The edge-primary model selects edge on WHEP
// connection, before any frame has been decoded — the stall watchdog must not
// fire during this cold-start window.
const FIRST_FRAME_GRACE_SECONDS = 12;

// Below this, "fps=0" is indistinguishable from no video track actually
// being active (audio-only ABR mode, or the very first ticks before any
// video byte has arrived) - not a stall.
const MIN_VIDEO_KBPS_TO_COUNT = 20;

// After triggering, ignore updates for a while - the recovery itself goes
// through the same zero-fps state for a few seconds while it renegotiates,
// which must not immediately retrigger.
const COOLDOWN_SECONDS = 20;

export class StallWatchdog {
    constructor({ stallSeconds = DEFAULT_STALL_SECONDS, firstFrameGraceSeconds = FIRST_FRAME_GRACE_SECONDS, onStall } = {}) {
        this.stallSeconds = stallSeconds;
        this.firstFrameGraceSeconds = firstFrameGraceSeconds;
        this.onStall = onStall;
        this.zeroFpsStreak = 0;
        this.cooldownRemaining = 0;
        this.startedAt = null;
    }

    // Called once a second from updateStats() with the same videoKbps/fps
    // it already computes. isVideoActive is whether the current track is
    // actually meant to show a picture right now (not audio-only, not
    // paused) - the caller already tracks this via abrEngine/videoPaused.
    update(videoKbps, fps, isVideoActive) {
        if (this.cooldownRemaining > 0) {
            this.cooldownRemaining--;
            return;
        }

        if (!isVideoActive || videoKbps < MIN_VIDEO_KBPS_TO_COUNT) {
            this.zeroFpsStreak = 0;
            return;
        }

        if (fps > 0) {
            this.zeroFpsStreak = 0;
            return;
        }

        // fps == 0, video is active, receiving data. The edge-primary model
        // selects edge on WHEP connection (before any frame has been decoded),
        // so during the initial grace window a fps=0/videoKbps>0 state is just
        // the cold-start phase, not a stall.
        if (this.startedAt && Date.now() - this.startedAt < this.firstFrameGraceSeconds * 1000) {
            this.zeroFpsStreak = 0;
            return;
        }

        this.zeroFpsStreak++;
        if (this.zeroFpsStreak >= this.stallSeconds) {
            this.zeroFpsStreak = 0;
            this.cooldownRemaining = COOLDOWN_SECONDS;
            if (this.onStall) this.onStall();
        }
    }

    reset() {
        this.zeroFpsStreak = 0;
        this.cooldownRemaining = 0;
        this.startedAt = Date.now();
    }
}
