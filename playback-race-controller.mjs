const PATH_EDGE = 'edge';
const PATH_P2P = 'p2p';

const defaultClock = {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
};

export class PlaybackRaceController {
    constructor({
        edgePath,
        p2pPath,
        raceWindowMs = 500,
        connectTimeoutMs = 2000,
        canSwitchToP2P = () => false,
        onSelected = () => {},
        onFailed = () => {},
        onTelemetry = () => {},
        clock = defaultClock,
    }) {
        if (!edgePath || !p2pPath) {
            throw new TypeError('edgePath and p2pPath are required');
        }
        if (raceWindowMs < 0 || connectTimeoutMs <= raceWindowMs) {
            throw new RangeError('connectTimeoutMs must be greater than raceWindowMs');
        }

        this.paths = { edge: edgePath, p2p: p2pPath };
        this.raceWindowMs = raceWindowMs;
        this.connectTimeoutMs = connectTimeoutMs;
        this.canSwitchToP2P = canSwitchToP2P;
        this.onSelected = onSelected;
        this.onFailed = onFailed;
        this.onTelemetry = onTelemetry;
        this.clock = clock;

        this.state = 'idle';
        this.selectedPath = null;
        this.startedAt = null;
        this.raceWindowElapsed = false;
        this.pathState = {
            edge: { failed: false, stopped: false, firstFrameAt: null },
            p2p: { failed: false, stopped: false, firstFrameAt: null },
        };
        this.raceTimer = null;
        this.p2pTimeoutTimer = null;
        this.failureReported = false;
    }

    start() {
        if (this.state !== 'idle') {
            throw new Error('playback race can only be started once');
        }

        this.state = 'racing';
        this.startedAt = this.clock.now();
        this._emit('race_started', {
            raceWindowMs: this.raceWindowMs,
            connectTimeoutMs: this.connectTimeoutMs,
        });

        this.raceTimer = this.clock.setTimeout(() => {
            if (this.state === 'stopped' || this.state === 'failed') {
                return;
            }
            this.raceWindowElapsed = true;
            this._emit('race_window_elapsed');
        }, this.raceWindowMs);

        this.p2pTimeoutTimer = this.clock.setTimeout(() => {
            if (this.pathState.p2p.firstFrameAt !== null || this.pathState.p2p.failed) {
                return;
            }
            this._emit('path_timeout', { path: PATH_P2P });
            this._stopPath(PATH_P2P, 'connect_timeout');
            this.pathState.p2p.failed = true;
            this._failIfExhausted();
        }, this.connectTimeoutMs);

        // Start both paths without awaiting either one, otherwise P2P can delay Edge.
        this._startPath(PATH_EDGE);
        this._startPath(PATH_P2P);
    }

    stop(reason = 'player_stopped') {
        if (this.state === 'stopped') {
            return;
        }

        this._clearTimers();
        this._stopPath(PATH_EDGE, reason);
        this._stopPath(PATH_P2P, reason);
        this.state = 'stopped';
        this._emit('race_stopped', { reason });
    }

    getState() {
        return {
            state: this.state,
            selectedPath: this.selectedPath,
            raceWindowElapsed: this.raceWindowElapsed,
            paths: {
                edge: { ...this.pathState.edge },
                p2p: { ...this.pathState.p2p },
            },
        };
    }

    _startPath(name) {
        const callbacks = {
            onFirstFrame: (frameInfo) => this._onFirstFrame(name, frameInfo),
            onFailed: (error) => this._onPathFailed(name, error),
        };

        try {
            Promise.resolve(this.paths[name].start(callbacks)).catch((error) => {
                this._onPathFailed(name, error);
            });
        } catch (error) {
            this._onPathFailed(name, error);
        }
    }

    _onFirstFrame(name, frameInfo) {
        if (this.state === 'stopped' || this.state === 'failed' ||
            this.pathState[name].failed || this.pathState[name].stopped ||
            this.pathState[name].firstFrameAt !== null) {
            return;
        }

        const elapsedMs = this.clock.now() - this.startedAt;
        this.pathState[name].firstFrameAt = elapsedMs;
        this._emit('path_first_frame', { path: name, elapsedMs, frameInfo });

        if (this.selectedPath === null) {
            this._select(name, 'first_frame');
            return;
        }

        if (name === PATH_P2P && this.selectedPath === PATH_EDGE) {
            if (this.canSwitchToP2P({
                edgeFirstFrameAt: this.pathState.edge.firstFrameAt,
                p2pFirstFrameAt: elapsedMs,
                frameInfo,
            })) {
                this._select(PATH_P2P, 'late_p2p_switch');
            } else {
                this._stopPath(PATH_P2P, 'late_switch_rejected');
                this._emit('late_p2p_rejected');
            }
        }
    }

    _onPathFailed(name, error) {
        if (this.state === 'stopped' || this.state === 'failed' ||
            this.pathState[name].failed || this.pathState[name].stopped) {
            return;
        }

        this.pathState[name].failed = true;
        this._emit('path_failed', {
            path: name,
            error: error instanceof Error ? error.message : String(error),
        });

        if (name === this.selectedPath) {
            const other = name === PATH_EDGE ? PATH_P2P : PATH_EDGE;
            if (this.pathState[other].firstFrameAt !== null &&
                !this.pathState[other].failed && !this.pathState[other].stopped) {
                this._select(other, 'selected_path_failed');
                return;
            }
            if (name === PATH_P2P && this.pathState.edge.stopped &&
                !this.pathState.edge.failed) {
                this.selectedPath = null;
                this.state = 'reconnecting_edge';
                this.pathState.edge.stopped = false;
                this.pathState.edge.firstFrameAt = null;
                this._emit('path_restarting', {
                    path: PATH_EDGE,
                    reason: 'p2p_runtime_failure',
                });
                this._startPath(PATH_EDGE);
                return;
            }
        }

        this._failIfExhausted();
    }

    _select(name, reason) {
        if (this.state === 'stopped' || this.state === 'failed') {
            return;
        }

        const previousPath = this.selectedPath;
        this.selectedPath = name;
        this.state = name === PATH_EDGE ? 'playing_edge' : 'playing_p2p';

        if (name === PATH_P2P) {
            this._stopPath(PATH_EDGE, 'p2p_selected');
            if (this.p2pTimeoutTimer !== null) {
                this.clock.clearTimeout(this.p2pTimeoutTimer);
                this.p2pTimeoutTimer = null;
            }
        }

        this._emit('path_selected', { path: name, previousPath, reason });
        this.onSelected({ path: name, previousPath, reason });
    }

    _failIfExhausted() {
        const unavailable = (name) => this.pathState[name].failed || this.pathState[name].stopped;
        if (!unavailable(PATH_EDGE) || !unavailable(PATH_P2P) || this.failureReported) {
            return;
        }

        this.failureReported = true;
        this._clearTimers();
        this.state = 'failed';
        const error = new Error('edge and P2P playback paths are unavailable');
        this._emit('race_failed', { error: error.message });
        this.onFailed(error);
    }

    _stopPath(name, reason) {
        if (this.pathState[name].stopped) {
            return;
        }
        this.pathState[name].stopped = true;
        try {
            this.paths[name].stop(reason);
        } catch (error) {
            this._emit('path_stop_failed', {
                path: name,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    _clearTimers() {
        if (this.raceTimer !== null) {
            this.clock.clearTimeout(this.raceTimer);
            this.raceTimer = null;
        }
        if (this.p2pTimeoutTimer !== null) {
            this.clock.clearTimeout(this.p2pTimeoutTimer);
            this.p2pTimeoutTimer = null;
        }
    }

    _emit(event, details = {}) {
        this.onTelemetry({ event, at: this.clock.now(), ...details });
    }
}
