import assert from 'node:assert/strict';
import test from 'node:test';

import { PlaybackRaceController } from '../playback-race-controller.mjs';
import { P2PPlaybackPath } from '../playback-paths.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeClock {
    time = 0;
    nextId = 1;
    timers = new Map();
    now = () => this.time;
    setTimeout = (callback, delay) => {
        const id = this.nextId++;
        this.timers.set(id, { callback, delay });
        return id;
    };
    clearTimeout = (id) => this.timers.delete(id);
}

class FakeEdgePath {
    starts = 0;
    stops = [];
    callbacks = null;
    stream = { id: 'edge-stream' };
    sessionId = 'edge-session';
    pc = null; // edge is shown, not polled
    start(callbacks) { this.starts++; this.callbacks = callbacks; }
    stop(reason) { this.stops.push(reason ?? 'stopped'); }
    ready() { this.callbacks.onReady({ stream: this.stream }); }
    fail(error = new Error('edge failed')) { this.callbacks.onFailed(error); }
}

class FakeWebSocket {
    static OPEN = 1;
    constructor(url, protocols) {
        this.url = url;
        this.protocols = protocols;
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
        FakeWebSocket.instance = this;
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    message(message) { this.onmessage({ data: JSON.stringify(message) }); }
    error() { this.onerror?.(); }
}

class FakePeerConnection {
    constructor() {
        this.remoteDescription = null;
        this.connectionState = 'new';
        FakePeerConnection.instance = this;
    }
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async addIceCandidate() {}
    close() { this.connectionState = 'closed'; }
    // Media is arriving AND decoding - a healthy P2P peer.
    async getStats() {
        return new Map([['video', { type: 'inbound-rtp', kind: 'video', packetsReceived: 100, framesDecoded: 5 }]]);
    }
}

function createP2PPath(sessionId = 'session-1') {
    return new P2PPlaybackPath({
        session: { sessionId, signalUrl: 'wss://center.example/v1/p2p/signal', token: 'token' },
        WebSocketClass: FakeWebSocket,
        PeerConnectionClass: FakePeerConnection,
    });
}

test('P2P signaling failure never disturbs the playing edge', () => {
    const edgePath = new FakeEdgePath();
    const p2pPath = createP2PPath();
    const selections = [];
    const controller = new PlaybackRaceController({
        edgePath,
        p2pPath,
        clock: new FakeClock(),
        onSelected: (selection) => selections.push(selection),
    });

    controller.start();
    edgePath.ready();
    FakeWebSocket.instance.error();

    assert.equal(selections[0].path, 'edge');
    assert.deepEqual(edgePath.stops, []);
    assert.equal(controller.getState().selectedPath, 'edge');
    controller.stop();
});

test('a real P2P leg that delivers and decodes is committed, dropping edge', async () => {
    const edgePath = new FakeEdgePath();
    const p2pPath = createP2PPath('session-2');
    const selections = [];
    const controller = new PlaybackRaceController({
        edgePath,
        p2pPath,
        clock: new FakeClock(),
        onSelected: (selection) => selections.push(selection),
    });

    controller.start();
    edgePath.ready();
    FakeWebSocket.instance.message({ v: 1, type: 'ready' });
    await flush();
    FakePeerConnection.instance.connectionState = 'connected';
    FakePeerConnection.instance.ontrack({ streams: [{ id: 'p2p-stream' }] });
    await flush();

    assert.equal(controller.getState().state, 'playing_p2p');
    assert.deepEqual(selections.map((s) => s.path), ['edge', 'p2p']);
    assert.deepEqual(edgePath.stops, ['stopped']);
    controller.stop();
});

test('a committed P2P leg that later fails restarts the edge fallback', async () => {
    const edgePath = new FakeEdgePath();
    const p2pPath = createP2PPath('session-3');
    const selections = [];
    const controller = new PlaybackRaceController({
        edgePath,
        p2pPath,
        clock: new FakeClock(),
        onSelected: (selection) => selections.push(selection),
    });

    controller.start();
    edgePath.ready();
    FakeWebSocket.instance.message({ v: 1, type: 'ready' });
    await flush();
    FakePeerConnection.instance.connectionState = 'connected';
    FakePeerConnection.instance.ontrack({ streams: [{ id: 'p2p-stream' }] });
    await flush();
    assert.equal(controller.getState().state, 'playing_p2p');
    assert.equal(edgePath.starts, 1);

    FakePeerConnection.instance.connectionState = 'failed';
    FakePeerConnection.instance.onconnectionstatechange();

    assert.equal(controller.getState().state, 'reconnecting_edge');
    assert.equal(edgePath.starts, 2); // edge restarted
    edgePath.ready();
    assert.equal(controller.getState().state, 'playing_edge');
    assert.equal(controller.getState().selectedPath, 'edge');
    controller.stop();
});
