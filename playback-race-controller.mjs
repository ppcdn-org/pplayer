const PATH_EDGE = 'edge';
const PATH_P2P = 'p2p';

const defaultClock = {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
};

// Edge-primary playback with a verified, non-disruptive P2P upgrade.
//
// Product rule (2026-09-24): P2P exists ONLY to save edge bandwidth and must
// never cost user experience - the viewer defaults to the edge node. So:
//   * Edge is shown the instant it connects. It is the guaranteed path and is
//     NEVER torn down until P2P has proven, on-screen, that it can decode.
//   * P2P runs in the background. It is detected as "delivering media" purely
//     from transport stats (inbound packetsReceived), which move even while the
//     track is off-screen - so a working P2P is found without disturbing edge.
//   * Only then is P2P put on-screen on trial, with edge kept alive; if P2P
//     decodes within a short window it is committed (edge dropped, bandwidth
//     saved), otherwise the visible element reverts to the still-live edge with
//     no gap. A symmetric-NAT viewer (whose P2P ICE never connects, so no
//     packets ever arrive) simply stays on edge and never notices.
//
// Why not decide P2P on framesDecoded directly, like a real race? Because
// Chrome only spins up the decode pipeline for an inbound track once it is
// attached to the on-screen <video> (confirmed in production 2026-09-24: an
// off-screen sink and a MediaStreamTrackProcessor both leave framesDecoded at
// 0). Decode can therefore only be verified after showing the stream, which is
// exactly what the trial does.
export class PlaybackRaceController {
    constructor({
        edgePath,
        p2pPath,
        // How long P2P has to start delivering media before we give up on it
        // for this session and stay on edge. A symmetric-NAT viewer never
        // delivers, so this just bounds the wasted background attempt.
        p2pConnectTimeoutMs = 8000,
        // After P2P is put on-screen on trial, how long to confirm it actually
        // decodes before reverting to edge.
        p2pVerifyMs = 2500,
        pollIntervalMs = 150,
        onSelected = () => {},
        onFailed = () => {},
        onTelemetry = () => {},
        clock = defaultClock,
    }) {
        if (!edgePath || !p2pPath) {
            throw new TypeError('edgePath and p2pPath are required');
        }
        this.edgePath = edgePath;
        this.p2pPath = p2pPath;
        this.p2pConnectTimeoutMs = p2pConnectTimeoutMs;
        this.p2pVerifyMs = p2pVerifyMs;
        this.pollIntervalMs = pollIntervalMs;
        this.onSelected = onSelected;
        this.onFailed = onFailed;
        this.onTelemetry = onTelemetry;
        this.clock = clock;

        // idle | connecting | playing_edge | p2p_trial | playing_p2p | failed | stopped
        this.state = 'idle';
        this.selectedPath = null;
        this.edgeState = { ready: false, failed: false };
        this.p2pState = { flowing: false, failed: false, done: false };
        this.failureReported = false;
        this._timers = new Set();
        this._cancelMediaPoll = null;
        this._cancelVerifyPoll = null;
        this._p2pDeadline = null;
        this._verifyDeadline = null;
    }

    start() {
        if (this.state !== 'idle') {
            throw new Error('playback controller can only be started once');
        }
        this.state = 'connecting';
        this._emit('start', { p2pConnectTimeoutMs: this.p2pConnectTimeoutMs, p2pVerifyMs: this.p2pVerifyMs });

        this._startPath(this.edgePath, {
            onReady: () => this._edgeReady(),
            onFailed: (error) => this._edgeFailed(error),
        });
        this._startPath(this.p2pPath, {
            onNegotiated: () => this._p2pNegotiated(),
            onFailed: (error) => this._p2pFailed(error),
        });

        this._p2pDeadline = this._setTimeout(() => {
            if (this.state === 'playing_p2p' || this.p2pState.done) return;
            this._emit('p2p_give_up', { reason: 'no_media_within_timeout' });
            this._abandonP2P();
        }, this.p2pConnectTimeoutMs);
    }

    stop(reason = 'player_stopped') {
        if (this.state === 'stopped') return;
        this._teardownPolls();
        this._clearTimers();
        this._stopEdge();
        this._stopP2P();
        this.state = 'stopped';
        this._emit('stopped', { reason });
    }

    getState() {
        return {
            state: this.state,
            selectedPath: this.selectedPath,
            edge: { ...this.edgeState },
            p2p: { ...this.p2pState },
        };
    }

    _startPath(path, callbacks) {
        try {
            Promise.resolve(path.start(callbacks)).catch((error) => callbacks.onFailed(error));
        } catch (error) {
            callbacks.onFailed(error);
        }
    }

    _edgeReady() {
        if (this._terminal() || this.edgeState.ready) return;
        this.edgeState.ready = true;
        // P2P only ever takes the screen after edge is already playing, so at
        // edge-ready time nothing else can hold it; guard regardless.
        if (this.selectedPath === null) {
            this.selectedPath = PATH_EDGE;
            this.state = 'playing_edge';
            this._emit('edge_playing');
            this.onSelected({ path: PATH_EDGE, previousPath: null, reason: 'edge_ready' });
        }
        // P2P media may already be flowing (it connected before edge); upgrade
        // now that edge is playing and can be the revert target.
        this._maybeUpgradeToP2P();
    }

    _p2pNegotiated() {
        if (this._terminal() || this.p2pState.done || this.p2pState.flowing || this._cancelMediaPoll) return;
        // Watch for real inbound media on the P2P peer without putting it
        // on-screen. packetsReceived advancing on a connected PC means media is
        // actually arriving (a symmetric-NAT viewer never gets here).
        this._cancelMediaPoll = this._pollInbound(
            () => this.p2pPath.pc,
            (report, pc) => report.packetsReceived > 0 &&
                (pc.connectionState === 'connected' || pc.connectionState === 'completed' || pc.connectionState === undefined),
            () => this._p2pMediaFlowing(),
        );
    }

    _p2pMediaFlowing() {
        if (this._terminal() || this.p2pState.done) return;
        this.p2pState.flowing = true;
        this._cancelMediaPoll?.();
        this._cancelMediaPoll = null;
        // Edge may not be playing yet (P2P delivered media first); the upgrade
        // waits until it is, so edge is always the revert target.
        this._maybeUpgradeToP2P();
    }

    _maybeUpgradeToP2P() {
        if (this._terminal() || this.p2pState.done) return;
        if (this.state !== 'playing_edge' || !this.p2pState.flowing) return;
        // Trial: show P2P but keep edge running, so a revert is an instant
        // re-attach of the still-live edge stream with no visible gap.
        this.state = 'p2p_trial';
        this._emit('p2p_trial');
        this.onSelected({ path: PATH_P2P, previousPath: PATH_EDGE, reason: 'p2p_media_flowing' });
        // Confirm P2P actually decodes on-screen within the window, else revert
        // to the still-live edge. The deadline is a single timer (not folded
        // into the poll) so a revert fires deterministically.
        this._verifyDeadline = this._setTimeout(() => this._revertToEdge('p2p_no_decode'), this.p2pVerifyMs);
        this._cancelVerifyPoll = this._pollInbound(
            () => this.p2pPath.pc,
            (report) => report.framesDecoded > 0,
            () => this._commitP2P(),
        );
    }

    _commitP2P() {
        if (this._terminal() || this.state !== 'p2p_trial') return;
        this._cancelVerifyPoll?.();
        this._cancelVerifyPoll = null;
        this._clearTimer(this._verifyDeadline);
        this._verifyDeadline = null;
        this._clearTimer(this._p2pDeadline);
        this._p2pDeadline = null;
        this.selectedPath = PATH_P2P;
        this.state = 'playing_p2p';
        this.p2pState.done = true;
        // P2P is proven on-screen; drop edge to actually save the bandwidth.
        this._stopEdge();
        this._emit('p2p_committed');
    }

    _revertToEdge(reason) {
        if (this._terminal() || this.state !== 'p2p_trial') return;
        this._cancelVerifyPoll?.();
        this._cancelVerifyPoll = null;
        this._clearTimer(this._verifyDeadline);
        this._verifyDeadline = null;
        this.p2pState.done = true;
        this.p2pState.failed = true;
        this.selectedPath = PATH_EDGE;
        this.state = 'playing_edge';
        this._emit('p2p_reverted', { reason });
        this.onSelected({ path: PATH_EDGE, previousPath: PATH_P2P, reason });
        this._stopP2P();
    }

    _abandonP2P() {
        if (this.p2pState.done) return;
        this.p2pState.done = true;
        this._cancelMediaPoll?.();
        this._cancelMediaPoll = null;
        this._stopP2P();
    }

    _edgeFailed(error) {
        if (this._terminal() || this.edgeState.failed) return;
        this.edgeState.failed = true;
        this._emit('edge_failed', { error: errMessage(error) });
        // Edge is irrelevant once P2P has committed. While P2P is mid-trial the
        // verify poll may still commit (or revert - which will then re-fail
        // here with edge already flagged). Otherwise edge was the guaranteed
        // path and it is gone: playback can no longer be promised.
        if (this.state === 'playing_p2p' || this.state === 'p2p_trial') return;
        this._fail(new Error('edge playback path is unavailable'));
    }

    _p2pFailed(error) {
        if (this._terminal()) return;
        // Committed P2P dropping mid-stream is the one case where edge is gone
        // (it was torn down to save bandwidth). Restart it - a brief edge
        // reconnect beats a dead stream, and never degrading playback is the
        // whole point of keeping edge as the default.
        if (this.state === 'playing_p2p') {
            this._emit('p2p_failed', { error: errMessage(error) });
            this._stopP2P();
            this._restartEdge('p2p_runtime_failure');
            return;
        }
        if (this.p2pState.done) return;
        this.p2pState.done = true;
        this.p2pState.failed = true;
        this._cancelMediaPoll?.();
        this._cancelMediaPoll = null;
        this._cancelVerifyPoll?.();
        this._cancelVerifyPoll = null;
        this._clearTimer(this._verifyDeadline);
        this._verifyDeadline = null;
        this._emit('p2p_failed', { error: errMessage(error) });
        // If P2P failed while on trial (on-screen), fall back to edge, which was
        // never stopped. Otherwise edge just keeps playing, untouched.
        if (this.state === 'p2p_trial') {
            this.selectedPath = PATH_EDGE;
            this.state = 'playing_edge';
            this.onSelected({ path: PATH_EDGE, previousPath: PATH_P2P, reason: 'p2p_failed' });
        }
        this._stopP2P();
    }

    // Bring edge back after a committed P2P dropped. P2P is already marked done
    // so the reconnected edge is not re-upgraded to the dead peer.
    _restartEdge(reason) {
        this.selectedPath = null;
        this.state = 'reconnecting_edge';
        this.edgeState = { ready: false, failed: false };
        this._clearTimer(this._p2pDeadline);
        this._p2pDeadline = null;
        this._emit('edge_restarting', { reason });
        this._startPath(this.edgePath, {
            onReady: () => this._edgeReady(),
            onFailed: (err) => this._edgeFailed(err),
        });
    }

    _fail(error) {
        if (this.failureReported) return;
        this.failureReported = true;
        this._teardownPolls();
        this._clearTimers();
        this.state = 'failed';
        this._emit('failed', { error: errMessage(error) });
        this.onFailed(error);
    }

    _terminal() {
        return this.state === 'stopped' || this.state === 'failed';
    }

    _stopEdge() { try { this.edgePath.stop?.(); } catch { /* best-effort */ } }
    _stopP2P() { try { this.p2pPath.stop?.(); } catch { /* best-effort */ } }

    _teardownPolls() {
        this._cancelMediaPoll?.();
        this._cancelMediaPoll = null;
        this._cancelVerifyPoll?.();
        this._cancelVerifyPoll = null;
    }

    _setTimeout(callback, delay) {
        const timer = this.clock.setTimeout(() => { this._timers.delete(timer); callback(); }, delay);
        this._timers.add(timer);
        return timer;
    }

    _clearTimer(timer) {
        if (timer == null) return;
        this.clock.clearTimeout(timer);
        this._timers.delete(timer);
    }

    _clearTimers() {
        for (const timer of this._timers) this.clock.clearTimeout(timer);
        this._timers.clear();
    }

    // Polls the given PC's inbound-rtp video report until `predicate` holds
    // (-> onMatch), then stops. Returns a canceller. Timeouts are handled by
    // the caller's own deadline timer, not here, so this stays a pure "wait
    // until true" and testing a revert only needs to fire that one timer.
    _pollInbound(getPc, predicate, onMatch) {
        let stopped = false;
        const tick = async () => {
            if (stopped || this._terminal()) return;
            const pc = getPc();
            let matched = false;
            if (pc && typeof pc.getStats === 'function') {
                const stats = await pc.getStats().catch(() => null);
                if (stats) {
                    for (const report of stats.values()) {
                        if (report.type === 'inbound-rtp' && report.kind === 'video' && predicate(report, pc)) {
                            matched = true;
                            break;
                        }
                    }
                }
            }
            if (stopped || this._terminal()) return;
            if (matched) { onMatch(); return; }
            this.clock.setTimeout(tick, this.pollIntervalMs);
        };
        tick();
        return () => { stopped = true; };
    }

    _emit(event, details = {}) {
        this.onTelemetry({ event, at: this.clock.now(), ...details });
    }
}

function errMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
