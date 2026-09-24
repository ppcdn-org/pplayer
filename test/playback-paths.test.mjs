import assert from 'node:assert/strict';
import test from 'node:test';

import { EdgeWHEPPath, P2PPlaybackPath } from '../playback-paths.mjs';

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
    closed() { this.readyState = 3; this.onclose?.(); }
}

class FakePeerConnection {
    constructor(config) { this.config = config; this.remoteDescription = null; this.connectionState = 'new'; this.candidates = []; FakePeerConnection.instance = this; }
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async addIceCandidate(candidate) { this.candidates.push(candidate); this.candidate = candidate; }
    close() { this.connectionState = 'closed'; }
    async getStats() { return new Map(); }
}

class FakeReader {
    constructor(options) {
        this.options = options;
        this.sessionId = 'edge-session-1';
        this.closed = false;
        this.pc = { getStats: async () => new Map() };
        FakeReader.instance = this;
    }
    // onTrack lands the media stream, then onConnected marks the leg ready -
    // matching the SDK's real order (track before connected).
    connect(stream = { id: 'edge-stream' }) {
        this.options.onTrack({ streams: [stream] });
        this.options.onConnected();
    }
    fail(error = new Error('edge failed')) { this.options.onError(error); }
    close() { this.closed = true; }
}

test('Edge WHEP path reports onReady with the stream on connect, and exposes sessionId/pc', () => {
    const ready = [];
    const path = new EdgeWHEPPath({ url: 'https://edge.example/app/live/whep', ReaderClass: FakeReader });
    path.start({ onReady: (info) => ready.push(info), onFailed(error) { throw error; } });

    FakeReader.instance.connect();

    assert.equal(FakeReader.instance.options.url, 'https://edge.example/app/live/whep');
    assert.equal(FakeReader.instance.options.maxBitrate, 2500);
    assert.equal(path.sessionId, 'edge-session-1');
    assert.equal(path.pc, FakeReader.instance.pc);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].stream.id, 'edge-stream');
});

test('Edge WHEP path forwards reader errors and closes reader on stop', () => {
    const failures = [];
    const path = new EdgeWHEPPath({ url: 'https://edge.example/app/live/whep', ReaderClass: FakeReader });
    path.start({ onReady() {}, onFailed(error) { failures.push(error); } });

    FakeReader.instance.fail();
    path.stop();

    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /edge failed/);
    assert.equal(FakeReader.instance.closed, true);
    assert.equal(path.pc, null);
});

test('P2P path authenticates with subprotocol and sends offer and ICE', async () => {
    const path = new P2PPlaybackPath({
        session: { sessionId: 'session-1', signalUrl: 'wss://center.example/v1/p2p/signal', token: 'secret' },
        WebSocketClass: FakeWebSocket,
        PeerConnectionClass: FakePeerConnection,
    });
    path.start({ onNegotiated() {}, onFailed(error) { throw error; } });
    assert.deepEqual(FakeWebSocket.instance.protocols, ['ppcdn-p2p-v1', 'ppcdn-token.secret']);

    FakeWebSocket.instance.message({ v: 1, type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(FakeWebSocket.instance.sent[0].type, 'offer');
    assert.equal(FakeWebSocket.instance.sent[0].sessionId, 'session-1');
    assert.equal(FakeWebSocket.instance.sent[0].seq, 1);
    assert.equal(typeof FakeWebSocket.instance.sent[0].sentAt, 'number');

    FakePeerConnection.instance.onicecandidate({ candidate: { toJSON: () => ({ candidate: 'candidate:1' }) } });
    assert.equal(FakeWebSocket.instance.sent[1].type, 'ice');
    assert.equal(FakeWebSocket.instance.sent[1].seq, 2);

    FakeWebSocket.instance.message({ v: 1, type: 'answer', sessionId: 'session-1', sdp: 'answer-sdp' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(FakePeerConnection.instance.remoteDescription.sdp, 'answer-sdp');

    path.stop('test');
    assert.equal(FakeWebSocket.instance.sent.at(-1).type, 'close');
    assert.equal(FakeWebSocket.instance.sent.at(-1).seq, 3);
});

test('P2P path reports onNegotiated once its media track lands', async () => {
    const negotiated = [];
    const path = new P2PPlaybackPath({
        session: { sessionId: 'session-neg', signalUrl: 'wss://center.example/v1/p2p/signal', token: 'secret' },
        WebSocketClass: FakeWebSocket,
        PeerConnectionClass: FakePeerConnection,
    });
    path.start({ onNegotiated: (info) => negotiated.push(info), onFailed(error) { throw error; } });
    FakeWebSocket.instance.message({ v: 1, type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));

    const stream = { id: 'p2p-stream' };
    FakePeerConnection.instance.ontrack({ streams: [stream] });
    assert.equal(negotiated.length, 1);
    assert.equal(negotiated[0].stream.id, 'p2p-stream');
    assert.equal(path.pc, FakePeerConnection.instance);

    // Fires only once even if more tracks (e.g. audio) arrive.
    FakePeerConnection.instance.ontrack({ streams: [stream] });
    assert.equal(negotiated.length, 1);

    path.stop('done');
});

test('P2P path buffers remote ICE until answer is applied', async () => {
    const path = new P2PPlaybackPath({
        session: { sessionId: 'session-2', signalUrl: 'wss://center.example/v1/p2p/signal', token: 'secret' },
        WebSocketClass: FakeWebSocket,
        PeerConnectionClass: FakePeerConnection,
    });
    path.start({ onNegotiated() {}, onFailed(error) { throw error; } });
    FakeWebSocket.instance.message({ v: 1, type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));

    const earlyCandidate = { candidate: 'candidate:early', sdpMid: '0' };
    FakeWebSocket.instance.message({ v: 1, type: 'ice', sessionId: 'session-2', candidate: earlyCandidate });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(FakePeerConnection.instance.candidates.length, 0);

    FakeWebSocket.instance.message({ v: 1, type: 'answer', sessionId: 'session-2', sdp: 'answer-sdp' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(FakePeerConnection.instance.candidates, [earlyCandidate]);

    const lateCandidate = { candidate: 'candidate:late', sdpMid: '0' };
    FakeWebSocket.instance.message({ v: 1, type: 'ice', sessionId: 'session-2', candidate: lateCandidate });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(FakePeerConnection.instance.candidates, [earlyCandidate, lateCandidate]);
});

test('P2P path reports center error messages as failures', () => {
    const failures = [];
    const path = new P2PPlaybackPath({
        session: { sessionId: 'session-3', signalUrl: 'wss://center.example/v1/p2p/signal', token: 'secret' },
        WebSocketClass: FakeWebSocket,
        PeerConnectionClass: FakePeerConnection,
    });
    path.start({ onNegotiated() {}, onFailed(error) { failures.push(error); } });

    FakeWebSocket.instance.message({ v: 1, type: 'error', reason: 'invalid session' });

    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /invalid session/);
});

test('P2P path reports signaling close and errors as failures', () => {
    const failures = [];
    const path = new P2PPlaybackPath({
        session: { sessionId: 'session-4', signalUrl: 'wss://center.example/v1/p2p/signal', token: 'secret' },
        WebSocketClass: FakeWebSocket,
        PeerConnectionClass: FakePeerConnection,
    });
    path.start({ onNegotiated() {}, onFailed(error) { failures.push(error); } });

    FakeWebSocket.instance.error();
    FakeWebSocket.instance.closed();

    assert.equal(failures.length, 2);
    assert.match(failures[0].message, /signaling failed/);
    assert.match(failures[1].message, /signaling closed/);
});

test('P2P path configures iceServers from session.stunServers on offer', async () => {
    const path = new P2PPlaybackPath({
        session: {
            sessionId: 'session-6', signalUrl: 'wss://center.example/v1/p2p/signal', token: 'secret',
            stunServers: ['stun:api.pp-cdn.org:3478'],
        },
        WebSocketClass: FakeWebSocket,
        PeerConnectionClass: FakePeerConnection,
    });
    path.start({ onNegotiated() {}, onFailed(error) { throw error; } });
    FakeWebSocket.instance.message({ v: 1, type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(FakePeerConnection.instance.config, { iceServers: [{ urls: 'stun:api.pp-cdn.org:3478' }] });
});

test('P2P path drops non-stun entries and constructs with no config when nothing survives', async () => {
    const path = new P2PPlaybackPath({
        session: {
            sessionId: 'session-7', signalUrl: 'wss://center.example/v1/p2p/signal', token: 'secret',
            stunServers: ['turn:relay.example:3478', 42, null],
        },
        WebSocketClass: FakeWebSocket,
        PeerConnectionClass: FakePeerConnection,
    });
    path.start({ onNegotiated() {}, onFailed(error) { throw error; } });
    FakeWebSocket.instance.message({ v: 1, type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(FakePeerConnection.instance.config, undefined);
});

test('P2P path constructs with no iceServers config when session has no stunServers (unchanged default)', async () => {
    const path = new P2PPlaybackPath({
        session: { sessionId: 'session-8', signalUrl: 'wss://center.example/v1/p2p/signal', token: 'secret' },
        WebSocketClass: FakeWebSocket,
        PeerConnectionClass: FakePeerConnection,
    });
    path.start({ onNegotiated() {}, onFailed(error) { throw error; } });
    FakeWebSocket.instance.message({ v: 1, type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(FakePeerConnection.instance.config, undefined);
});

test('P2P path reports PeerConnection failure', async () => {
    const failures = [];
    const path = new P2PPlaybackPath({
        session: { sessionId: 'session-5', signalUrl: 'wss://center.example/v1/p2p/signal', token: 'secret' },
        WebSocketClass: FakeWebSocket,
        PeerConnectionClass: FakePeerConnection,
    });
    path.start({ onNegotiated() {}, onFailed(error) { failures.push(error); } });
    FakeWebSocket.instance.message({ v: 1, type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));

    FakePeerConnection.instance.connectionState = 'failed';
    FakePeerConnection.instance.onconnectionstatechange();

    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /P2P connection failed/);
});

test('paths tolerate having no DOM (Node) and no decode-sink machinery', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    const path = new EdgeWHEPPath({ url: 'https://edge.example/app/live/whep', ReaderClass: FakeReader });
    path.start({ onReady() {}, onFailed(error) { throw error; } });
    FakeReader.instance.connect();
    // releaseDecodeSink is a retained no-op for main.js compatibility.
    assert.doesNotThrow(() => path.releaseDecodeSink());
    path.stop();
});
