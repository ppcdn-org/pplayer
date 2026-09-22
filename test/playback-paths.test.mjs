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
        this.pc = {
            getStats: async () => new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: 1 }]]),
        };
        FakeReader.instance = this;
    }
    connect(stream = { id: 'edge-stream' }) {
        this.options.onTrack({ streams: [stream] });
        this.options.onConnected();
    }
    fail(error = new Error('edge failed')) { this.options.onError(error); }
    close() { this.closed = true; }
}

test('Edge WHEP path reports first frame and exposes sessionId', async () => {
    const frames = [];
    const path = new EdgeWHEPPath({ url: 'https://edge.example/app/live/whep', ReaderClass: FakeReader });
    path.start({ onFirstFrame: (info) => frames.push(info), onFailed(error) { throw error; } });

    FakeReader.instance.connect();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(FakeReader.instance.options.url, 'https://edge.example/app/live/whep');
    assert.equal(FakeReader.instance.options.maxBitrate, 2500);
    assert.equal(path.sessionId, 'edge-session-1');
    assert.equal(path.pc, FakeReader.instance.pc);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].stream.id, 'edge-stream');
});

test('Edge WHEP path forwards reader errors and closes reader on stop', () => {
    const failures = [];
    const path = new EdgeWHEPPath({ url: 'https://edge.example/app/live/whep', ReaderClass: FakeReader });
    path.start({ onFirstFrame() {}, onFailed(error) { failures.push(error); } });

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
    path.start({ onFirstFrame() {}, onFailed(error) { throw error; } });
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

test('P2P path buffers remote ICE until answer is applied', async () => {
    const path = new P2PPlaybackPath({
        session: { sessionId: 'session-2', signalUrl: 'wss://center.example/v1/p2p/signal', token: 'secret' },
        WebSocketClass: FakeWebSocket,
        PeerConnectionClass: FakePeerConnection,
    });
    path.start({ onFirstFrame() {}, onFailed(error) { throw error; } });
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
    path.start({ onFirstFrame() {}, onFailed(error) { failures.push(error); } });

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
    path.start({ onFirstFrame() {}, onFailed(error) { failures.push(error); } });

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
    path.start({ onFirstFrame() {}, onFailed(error) { throw error; } });
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
    path.start({ onFirstFrame() {}, onFailed(error) { throw error; } });
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
    path.start({ onFirstFrame() {}, onFailed(error) { throw error; } });
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
    path.start({ onFirstFrame() {}, onFailed(error) { failures.push(error); } });
    FakeWebSocket.instance.message({ v: 1, type: 'ready' });
    await new Promise((resolve) => setImmediate(resolve));

    FakePeerConnection.instance.connectionState = 'failed';
    FakePeerConnection.instance.onconnectionstatechange();

    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /P2P connection failed/);
});

// A browser only decodes an inbound track while something consumes it, and
// main.js attaches the visible <video> only to the race *winner* - so each
// leg needs its own sink to be able to decode a frame and win at all. See
// createDecodeSink in playback-paths.mjs; production 2026-09-22 deadlocked
// with both legs connected and silent because neither had one.
class FakeVideoElement {
    constructor() {
        this.muted = false;
        this.autoplay = false;
        this.playsInline = false;
        this.srcObject = null;
        this.style = {};
        this.removed = false;
        this.playCalls = 0;
    }
    play() { this.playCalls += 1; return Promise.resolve(); }
    remove() { this.removed = true; }
}

// Must be async and await `run`: with a plain `return run(...)` the finally
// block restores document the moment the promise is *created*, so anything
// in `run` after its first await would see no DOM again.
async function withFakeDocument(run) {
    const created = [];
    const appended = [];
    const previous = globalThis.document;
    globalThis.document = {
        createElement(tag) {
            const element = new FakeVideoElement();
            created.push({ tag, element });
            return element;
        },
        body: { appendChild(element) { appended.push(element); } },
    };
    try {
        return await run({ created, appended });
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
}

test('Edge path attaches a muted hidden decode sink on track, so framesDecoded can move', async () => {
    await withFakeDocument(async ({ created, appended }) => {
        const path = new EdgeWHEPPath({ url: 'https://edge.example/app/live/whep', ReaderClass: FakeReader });
        path.start({ onFirstFrame() {}, onFailed(error) { throw error; } });

        const stream = { id: 'edge-stream' };
        FakeReader.instance.connect(stream);

        assert.equal(created.length, 1);
        assert.equal(created[0].tag, 'video');
        const sink = created[0].element;
        assert.equal(sink.srcObject, stream);
        assert.equal(sink.muted, true);
        assert.equal(sink.playCalls, 1);
        assert.equal(appended[0], sink);
        // Invisible, but still rendered - a never-rendered element can have
        // its decoding throttled, which would reintroduce the deadlock.
        assert.match(sink.style.cssText, /opacity:0/);
        assert.doesNotMatch(sink.style.cssText, /display:\s*none/);
    });
});

test('Edge path releases its decode sink once the visible element takes over', async () => {
    await withFakeDocument(async ({ created }) => {
        const path = new EdgeWHEPPath({ url: 'https://edge.example/app/live/whep', ReaderClass: FakeReader });
        path.start({ onFirstFrame() {}, onFailed(error) { throw error; } });
        FakeReader.instance.connect();

        const sink = created[0].element;
        path.releaseDecodeSink();

        assert.equal(sink.srcObject, null);
        assert.equal(sink.removed, true);
        assert.equal(path.decodeSink, null);
        path.releaseDecodeSink(); // idempotent - onSelected may fire before stop()
    });
});

test('Edge path tears its decode sink down on stop, even without winning', async () => {
    await withFakeDocument(async ({ created }) => {
        const path = new EdgeWHEPPath({ url: 'https://edge.example/app/live/whep', ReaderClass: FakeReader });
        path.start({ onFirstFrame() {}, onFailed(error) { throw error; } });
        FakeReader.instance.connect();

        path.stop('p2p_selected');

        assert.equal(created[0].element.removed, true);
    });
});

test('P2P path attaches and releases its own decode sink the same way', async () => {
    await withFakeDocument(async ({ created }) => {
        const path = new P2PPlaybackPath({
            session: { sessionId: 'session-sink', signalUrl: 'wss://center.example/v1/p2p/signal', token: 'secret' },
            WebSocketClass: FakeWebSocket,
            PeerConnectionClass: FakePeerConnection,
        });
        path.start({ onFirstFrame() {}, onFailed(error) { throw error; } });
        FakeWebSocket.instance.message({ v: 1, type: 'ready' });
        await new Promise((resolve) => setImmediate(resolve));

        const stream = { id: 'p2p-stream' };
        FakePeerConnection.instance.ontrack({ streams: [stream] });

        assert.equal(created.length, 1);
        assert.equal(created[0].element.srcObject, stream);

        path.releaseDecodeSink();
        assert.equal(created[0].element.removed, true);

        // FakePeerConnection.getStats() never returns an inbound-rtp report,
        // so waitForVideoFrame is still polling on a timer here - stop()
        // cancels it, without which the runner's event loop never drains.
        path.stop('done');
    });
});

test('paths still work with no DOM at all (Node), rather than throwing on document', async () => {
    assert.equal(typeof globalThis.document, 'undefined');
    const path = new EdgeWHEPPath({ url: 'https://edge.example/app/live/whep', ReaderClass: FakeReader });
    path.start({ onFirstFrame() {}, onFailed(error) { throw error; } });
    FakeReader.instance.connect();
    assert.equal(path.decodeSink, null);
    path.stop('done');
});
