import assert from 'node:assert/strict';
import test from 'node:test';

import { PlaybackRaceController } from '../playback-race-controller.mjs';

// The controller polls PeerConnection.getStats() (async) between fake-clock
// timers. flush() drains those microtask chains; the fake clock drives the
// deadline timers. All timers are fake (Map entries), so nothing keeps Node
// alive between tests.
const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeClock {
    constructor() { this.time = 0; this.nextId = 1; this.timers = new Map(); }
    now = () => this.time;
    setTimeout = (callback, delay) => {
        const id = this.nextId++;
        this.timers.set(id, { at: this.time + delay, callback });
        return id;
    };
    clearTimeout = (id) => { this.timers.delete(id); };
    advance(ms) {
        const target = this.time + ms;
        while (true) {
            const due = [...this.timers.entries()]
                .filter(([, t]) => t.at <= target)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!due) break;
            this.time = due[1].at;
            this.timers.delete(due[0]);
            due[1].callback();
        }
        this.time = target;
    }
}

class FakeEdgePath {
    starts = 0; stops = []; cb = null;
    stream = { id: 'edge-stream' };
    start(cb) { this.starts++; this.cb = cb; }
    stop() { this.stops.push('stopped'); }
    ready() { this.cb.onReady({ stream: this.stream }); }
    fail(error = new Error('edge failed')) { this.cb.onFailed(error); }
    get pc() { return null; } // edge is never polled - it is shown, not probed
}

class FakeP2PPath {
    starts = 0; stops = []; cb = null;
    stream = { id: 'p2p-stream' };
    connectionState = 'connected';
    _stats = { packetsReceived: 0, framesDecoded: 0 };
    start(cb) { this.starts++; this.cb = cb; }
    stop() { this.stops.push('stopped'); }
    negotiate() { this.cb.onNegotiated({ stream: this.stream }); }
    fail(error = new Error('p2p failed')) { this.cb.onFailed(error); }
    setStats(patch) { Object.assign(this._stats, patch); }
    get pc() {
        const stats = this._stats;
        const connectionState = this.connectionState;
        return {
            connectionState,
            getStats: async () => new Map([['v', { type: 'inbound-rtp', kind: 'video', ...stats }]]),
        };
    }
}

function setup(options = {}) {
    const clock = new FakeClock();
    const edgePath = new FakeEdgePath();
    const p2pPath = new FakeP2PPath();
    const selections = [];
    const failures = [];
    const telemetry = [];
    const controller = new PlaybackRaceController({
        edgePath,
        p2pPath,
        clock,
        p2pConnectTimeoutMs: 5000,
        p2pVerifyMs: 1000,
        pollIntervalMs: 100,
        onSelected: (s) => selections.push(s),
        onFailed: (e) => failures.push(e),
        onTelemetry: (e) => telemetry.push(e),
        ...options,
    });
    return { controller, clock, edgePath, p2pPath, selections, failures, telemetry };
}

test('starts both legs and reports connecting', () => {
    const c = setup();
    c.controller.start();
    assert.equal(c.edgePath.starts, 1);
    assert.equal(c.p2pPath.starts, 1);
    assert.equal(c.controller.getState().state, 'connecting');
});

test('shows edge the moment it connects, without waiting on P2P', () => {
    const c = setup();
    c.controller.start();
    c.edgePath.ready();
    assert.equal(c.controller.getState().state, 'playing_edge');
    assert.equal(c.controller.getState().selectedPath, 'edge');
    assert.deepEqual(c.selections.map((s) => s.path), ['edge']);
    assert.deepEqual(c.p2pPath.stops, []); // P2P keeps running in the background
});

test('upgrades to P2P once it delivers media AND decodes on-screen, dropping edge', async () => {
    const c = setup();
    c.controller.start();
    c.edgePath.ready();
    c.p2pPath.setStats({ packetsReceived: 20, framesDecoded: 8 });
    c.p2pPath.negotiate();
    await flush();

    assert.equal(c.controller.getState().state, 'playing_p2p');
    assert.equal(c.controller.getState().selectedPath, 'p2p');
    assert.deepEqual(c.selections.map((s) => s.path), ['edge', 'p2p']);
    assert.deepEqual(c.edgePath.stops, ['stopped']); // edge dropped => bandwidth saved
    assert.deepEqual(c.p2pPath.stops, []);
});

test('reverts to edge with no gap when P2P delivers media but never decodes', async () => {
    const c = setup();
    c.controller.start();
    c.edgePath.ready();
    c.p2pPath.setStats({ packetsReceived: 20, framesDecoded: 0 }); // packets flow, but no decode
    c.p2pPath.negotiate();
    await flush();

    assert.equal(c.controller.getState().state, 'p2p_trial'); // shown on trial
    assert.deepEqual(c.selections.map((s) => s.path), ['edge', 'p2p']);
    assert.deepEqual(c.edgePath.stops, []); // edge was NOT stopped during the trial

    c.clock.advance(1000); // p2pVerifyMs -> verify deadline fires -> revert
    assert.equal(c.controller.getState().state, 'playing_edge');
    assert.equal(c.controller.getState().selectedPath, 'edge');
    assert.deepEqual(c.selections.map((s) => s.path), ['edge', 'p2p', 'edge']);
    assert.deepEqual(c.p2pPath.stops, ['stopped']);
});

test('symmetric-NAT viewer: P2P never delivers media, so edge is never disturbed', async () => {
    const c = setup();
    c.controller.start();
    c.edgePath.ready();
    c.p2pPath.setStats({ packetsReceived: 0, framesDecoded: 0 }); // ICE never connects -> no packets
    c.p2pPath.negotiate();
    await flush();

    assert.equal(c.controller.getState().state, 'playing_edge');
    c.clock.advance(5000); // p2pConnectTimeoutMs -> give up on P2P
    await flush();

    assert.equal(c.controller.getState().state, 'playing_edge');
    assert.deepEqual(c.selections.map((s) => s.path), ['edge']);
    assert.deepEqual(c.p2pPath.stops, ['stopped']);
    assert.equal(c.failures.length, 0);
});

test('upgrades even if P2P media arrives before edge connects (order-independent)', async () => {
    const c = setup();
    c.controller.start();
    c.p2pPath.setStats({ packetsReceived: 20, framesDecoded: 8 });
    c.p2pPath.negotiate();
    await flush(); // media flowing, but edge not ready yet -> no trial
    assert.equal(c.controller.getState().state, 'connecting');
    assert.deepEqual(c.selections.map((s) => s.path), []);

    c.edgePath.ready();
    await flush(); // edge playing -> upgrade proceeds -> decode confirmed -> commit
    assert.equal(c.controller.getState().state, 'playing_p2p');
    assert.deepEqual(c.selections.map((s) => s.path), ['edge', 'p2p']);
});

test('P2P failure never disturbs a playing edge', () => {
    const c = setup();
    c.controller.start();
    c.edgePath.ready();
    c.p2pPath.fail();
    assert.equal(c.controller.getState().state, 'playing_edge');
    assert.equal(c.controller.getState().selectedPath, 'edge');
    assert.deepEqual(c.edgePath.stops, []);
    assert.equal(c.failures.length, 0);
});

test('P2P failure mid-trial falls back to the still-live edge', async () => {
    const c = setup();
    c.controller.start();
    c.edgePath.ready();
    c.p2pPath.setStats({ packetsReceived: 20, framesDecoded: 0 });
    c.p2pPath.negotiate();
    await flush(); // p2p_trial
    assert.equal(c.controller.getState().state, 'p2p_trial');

    c.p2pPath.fail(new Error('ice dropped'));
    assert.equal(c.controller.getState().state, 'playing_edge');
    assert.equal(c.selections.at(-1).path, 'edge');
    assert.deepEqual(c.edgePath.stops, []);
});

test('reports failure when edge is unavailable and P2P has not taken over', () => {
    const c = setup();
    c.controller.start();
    c.edgePath.fail();
    assert.equal(c.controller.getState().state, 'failed');
    assert.equal(c.failures.length, 1);
    assert.match(c.failures[0].message, /edge playback path is unavailable/);
});

test('stop is idempotent and ignores late callbacks', async () => {
    const c = setup();
    c.controller.start();
    c.controller.stop();
    c.controller.stop();
    c.edgePath.ready();
    c.p2pPath.setStats({ packetsReceived: 20, framesDecoded: 8 });
    c.p2pPath.negotiate();
    await flush();

    assert.equal(c.controller.getState().state, 'stopped');
    assert.deepEqual(c.edgePath.stops, ['stopped']);
    assert.deepEqual(c.p2pPath.stops, ['stopped']);
    assert.equal(c.selections.length, 0);
    assert.equal(c.failures.length, 0);
});

test('can only be started once', () => {
    const c = setup();
    c.controller.start();
    assert.throws(() => c.controller.start(), /can only be started once/);
});
