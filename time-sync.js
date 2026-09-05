'use strict';

// Application-layer NTP-style clock offset calibration against ppcenter's
// /ws/play endpoint (PLY-014 / CTR-020; see docs/tech/P2P时延测量方案.md).
//
// Why this exists: p2p delay is computed as `now - <timestamp ppobs embedded
// when it sent the frame>`. That subtraction is only meaningful if both
// clocks share a base. ppobs disciplines itself against public NTP servers
// (see ntp-clock.c in the OBS repo), but a browser can't do real NTP - no
// UDP 123 - so its raw Date.now() may sit anywhere relative to UTC. Feeding
// an uncorrected clock into that subtraction produces nonsense: negative
// delays when the local clock runs ahead, absurdly large ones when it lags.
//
// The fix is the four-timestamp algorithm NTP uses internally, run over an
// ordinary WebSocket against ppcenter (which does run a real NTP daemon):
//
//   T1 = local time when the probe was sent
//   T2 = ppcenter's time when it received the probe
//   T3 = ppcenter's time when it replied
//   T4 = local time when the reply arrived
//
//   offset = ((T2 - T1) + (T3 - T4)) / 2   ~= ppcenterClock - localClock
//   rtt    = (T4 - T1) - (T3 - T2)         // network only, minus server time
//
// Correcting the local reading means ADDING offset, not subtracting it. The
// sign is easy to invert by accident, so: if the local clock runs 100ms ahead
// of ppcenter, offset comes out as -100, and local + (-100) cancels it.
//
// The algorithm assumes the two network directions are roughly symmetric.
// That's the standard NTP/PTP premise - it won't give microsecond accuracy,
// but it's far more than enough to tell a 200ms delay from a 145-second
// clock artifact.

const DEFAULT_PPCENTER_URL = 'http://127.0.0.1:18000';
// 30~60s per the design doc: device clocks drift, so a single calibration at
// startup goes stale over a long broadcast.
const DEFAULT_RESYNC_INTERVAL_MS = 45000;
const DEFAULT_SAMPLE_COUNT = 6;
const SAMPLE_SPACING_MS = 150;
const PROBE_TIMEOUT_MS = 5000;
const RECONNECT_DELAY_MS = 3000;

class TimeSync {
    constructor(options) {
        const opts = options || {};
        this.ppcenter = opts.ppcenter || DEFAULT_PPCENTER_URL;
        this.resyncIntervalMs = opts.resyncIntervalMs || DEFAULT_RESYNC_INTERVAL_MS;
        this.sampleCount = opts.sampleCount || DEFAULT_SAMPLE_COUNT;
        this.onStateChange = opts.onStateChange || null;

        this.ws = null;
        this.offsetMs = null;
        this.lastSyncAt = null;
        this.lastSyncRttMs = null;
        this.resyncTimer = null;
        this.reconnectTimer = null;
        this.pending = new Map(); // t1 -> { resolve, reject, timer }
        this.closed = false;
    }

    // Offset-corrected wall clock, or null when no calibration has succeeded
    // yet. Callers MUST treat null as "can't compute a delay yet" rather than
    // silently falling back to Date.now() - that fallback is exactly the bug
    // this class exists to prevent.
    now() {
        if (this.offsetMs === null) return null;
        return Date.now() + this.offsetMs;
    }

    isReady() {
        return this.offsetMs !== null;
    }

    start() {
        this.closed = false;
        return this._ensureConnected()
            .then(() => this.calibrate())
            .then((ok) => {
                this._scheduleResync();
                return ok;
            });
    }

    stop() {
        this.closed = true;
        if (this.resyncTimer) {
            clearTimeout(this.resyncTimer);
            this.resyncTimer = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.pending.forEach((p) => {
            clearTimeout(p.timer);
            p.reject(new Error('time sync stopped'));
        });
        this.pending.clear();
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            ws.onclose = null;
            try { ws.close(); } catch (e) { /* already closing */ }
        }
        this.offsetMs = null;
        this._notify();
    }

    _notify() {
        if (this.onStateChange) {
            this.onStateChange({
                ready: this.isReady(),
                offsetMs: this.offsetMs,
                rttMs: this.lastSyncRttMs,
                lastSyncAt: this.lastSyncAt,
            });
        }
    }

    _wsUrl() {
        const u = new URL('/ws/play', this.ppcenter);
        u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:';
        return u.toString();
    }

    _ensureConnected() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
        if (this.closed) return Promise.reject(new Error('time sync stopped'));

        return new Promise((resolve, reject) => {
            let settled = false;
            let ws;
            try {
                ws = new WebSocket(this._wsUrl());
            } catch (e) {
                reject(e);
                return;
            }
            this.ws = ws;

            ws.onopen = () => {
                settled = true;
                console.log('[TimeSync] connected to ppcenter');
                resolve();
            };
            ws.onmessage = (evt) => this._onMessage(evt);
            ws.onerror = () => {
                if (!settled) {
                    settled = true;
                    reject(new Error('time sync websocket error'));
                }
            };
            ws.onclose = () => {
                if (this.ws === ws) this.ws = null;
                if (!settled) {
                    settled = true;
                    reject(new Error('time sync websocket closed'));
                }
                this._scheduleReconnect();
            };
        });
    }

    // ppcenter may restart or the network may blip; keep trying so a long
    // playback session recovers its calibration instead of showing a stale
    // offset forever.
    _scheduleReconnect() {
        if (this.closed || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.closed) return;
            this._ensureConnected()
                .then(() => this.calibrate())
                .catch(() => { /* onclose schedules the next attempt */ });
        }, RECONNECT_DELAY_MS);
    }

    _scheduleResync() {
        if (this.closed) return;
        if (this.resyncTimer) clearTimeout(this.resyncTimer);
        this.resyncTimer = setTimeout(() => {
            this.calibrate()
                .catch(() => { /* keep the previous offset and retry next round */ })
                .then(() => this._scheduleResync());
        }, this.resyncIntervalMs);
    }

    _onMessage(evt) {
        let msg;
        try {
            msg = JSON.parse(evt.data);
        } catch (e) {
            return;
        }
        // /ws/play carries other message types (GET_WHEP_URL/PUB_PTS); ignore
        // everything that isn't our probe reply.
        if (!msg || msg.type !== 'TIME_SYNC_ACK') return;
        const pending = this.pending.get(msg.t1);
        if (!pending) return;
        this.pending.delete(msg.t1);
        clearTimeout(pending.timer);
        pending.resolve(msg);
    }

    _probeOnce() {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('time sync not connected'));
                return;
            }
            const t1 = Date.now();
            // Date.now() has ms resolution, so two probes in the same
            // millisecond would collide in the pending map keyed by t1.
            if (this.pending.has(t1)) {
                reject(new Error('duplicate probe timestamp'));
                return;
            }
            const timer = setTimeout(() => {
                this.pending.delete(t1);
                reject(new Error('time sync probe timed out'));
            }, PROBE_TIMEOUT_MS);

            this.pending.set(t1, {
                timer,
                reject,
                resolve: (msg) => {
                    const t4 = Date.now();
                    const offsetMs = ((msg.t2 - t1) + (msg.t3 - t4)) / 2;
                    const rttMs = (t4 - t1) - (msg.t3 - msg.t2);
                    resolve({ offsetMs, rttMs });
                },
            });

            try {
                this.ws.send(JSON.stringify({ type: 'TIME_SYNC', t1 }));
            } catch (e) {
                this.pending.delete(t1);
                clearTimeout(timer);
                reject(e);
            }
        });
    }

    // Takes sampleCount probes and keeps the one with the lowest RTT: a
    // shorter round trip means less queuing/jitter skewing the symmetry
    // assumption, so its offset is the most trustworthy. This is the standard
    // NTP/SNTP sample-selection approach. A failed probe isn't fatal; if every
    // probe fails we keep the previous offset rather than writing garbage, and
    // return false so the caller can decide whether to warn.
    calibrate() {
        return this._ensureConnected().then(() => {
            const samples = [];
            let chain = Promise.resolve();

            for (let i = 0; i < this.sampleCount; i++) {
                chain = chain
                    .then(() => this._probeOnce())
                    .then((s) => { samples.push(s); }, () => { /* try the next sample */ })
                    .then(() => new Promise((r) => setTimeout(r, SAMPLE_SPACING_MS)));
            }

            return chain.then(() => {
                if (samples.length === 0) {
                    console.warn('[TimeSync] calibration failed, keeping previous offset');
                    return false;
                }
                const best = samples.reduce((a, b) => (b.rttMs < a.rttMs ? b : a));
                this.offsetMs = best.offsetMs;
                this.lastSyncRttMs = best.rttMs;
                this.lastSyncAt = Date.now();
                console.log(
                    `[TimeSync] calibrated: offset=${best.offsetMs.toFixed(1)}ms ` +
                    `rtt=${best.rttMs.toFixed(1)}ms (${samples.length}/${this.sampleCount} samples)`);
                this._notify();
                return true;
            });
        });
    }

    // Fire-and-forget telemetry; drops the report when the socket isn't open
    // rather than buffering, since losing an occasional sample doesn't move a
    // P50/P95/P99 aggregate.
    reportLatency(path, delayMs) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        if (path !== 'edge' && path !== 'p2p') return false;
        if (!Number.isFinite(delayMs)) return false;
        this.ws.send(JSON.stringify({ type: 'LATENCY_REPORT', path, delayMs: Math.round(delayMs) }));
        return true;
    }
}

window.TimeSync = TimeSync;
