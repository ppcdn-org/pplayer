import assert from 'node:assert/strict';
import test from 'node:test';

import { P2PAnswerer } from '../p2p-answerer.mjs';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeWebSocket {
    static OPEN = 1;
    static instance = null;
    constructor(url, protocols) {
        this.url = url;
        this.protocols = protocols;
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        FakeWebSocket.instance = this;
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    emit(message) { return this.onmessage({ data: JSON.stringify(message) }); }
}

function fakePCFactory(created) {
    return function FakePC(config) {
        const pc = {
            config,
            remoteDescription: null,
            localDescription: null,
            connectionState: 'new',
            candidates: [],
            added: [],
            closed: false,
            onicecandidate: null,
            onconnectionstatechange: null,
            addTransceiver(track, opts) { pc.added.push({ track, opts }); return {}; },
            async setRemoteDescription(desc) { pc.remoteDescription = desc; },
            async createAnswer() { return { type: 'answer', sdp: 'ANSWER_SDP' }; },
            async setLocalDescription(desc) { pc.localDescription = desc; },
            async addIceCandidate(candidate) { pc.candidates.push(candidate); },
            close() { pc.closed = true; pc.connectionState = 'closed'; },
        };
        created.push(pc);
        return pc;
    };
}

const mediaStream = { getTracks: () => [{ kind: 'video' }, { kind: 'audio' }] };

function newAnswerer(overrides = {}, created = []) {
    return new P2PAnswerer({
        session: { signalUrl: 'wss://signal.example/v1/p2p/signal', token: 'tok', maxPeers: 3 },
        mediaStream,
        WebSocketClass: FakeWebSocket,
        PeerConnectionClass: fakePCFactory(created),
        ...overrides,
    });
}

test('P2PAnswerer opens the signaling socket with the token subprotocol', () => {
    const answerer = newAnswerer();
    answerer.start();
    assert.deepEqual(FakeWebSocket.instance.protocols, ['ppcdn-p2p-v1', 'ppcdn-token.tok']);
    assert.equal(FakeWebSocket.instance.url, 'wss://signal.example/v1/p2p/signal');
});

test('P2PAnswerer answers an incoming offer and sends sendonly tracks', async () => {
    const created = [];
    const answerer = newAnswerer({}, created);
    answerer.start();

    await FakeWebSocket.instance.emit({ v: 1, type: 'offer', sessionId: 's1', sdp: 'OFFER_SDP' });
    await flush();

    assert.equal(created.length, 1);
    assert.equal(created[0].remoteDescription.sdp, 'OFFER_SDP');
    assert.equal(created[0].added.length, 2);
    assert.deepEqual(created[0].added[0].opts.direction, 'sendonly');
    assert.equal(answerer.peerCount, 1);

    const answer = FakeWebSocket.instance.sent.find((m) => m.type === 'answer');
    assert.equal(answer.sessionId, 's1');
    assert.equal(answer.sdp, 'ANSWER_SDP');
});

test('P2PAnswerer enforces the P2P slot cap', async () => {
    const created = [];
    const answerer = newAnswerer({ session: { signalUrl: 'wss://signal.example/x', token: 'tok', maxPeers: 1 } }, created);
    answerer.start();

    await FakeWebSocket.instance.emit({ v: 1, type: 'offer', sessionId: 's1', sdp: 'O1' });
    await flush();
    await FakeWebSocket.instance.emit({ v: 1, type: 'offer', sessionId: 's2', sdp: 'O2' });
    await flush();

    assert.equal(created.length, 1);
    assert.equal(answerer.peerCount, 1);
    const fail = FakeWebSocket.instance.sent.find((m) => m.type === 'fail' && m.sessionId === 's2');
    assert.ok(fail, 'expected a fail for the over-capacity session');
});

test('P2PAnswerer forwards local ICE candidates and applies remote ones', async () => {
    const created = [];
    const answerer = newAnswerer({}, created);
    answerer.start();

    await FakeWebSocket.instance.emit({ v: 1, type: 'offer', sessionId: 's1', sdp: 'O' });
    await flush();

    created[0].onicecandidate({ candidate: { toJSON: () => ({ candidate: 'local-cand' }) } });
    const localIce = FakeWebSocket.instance.sent.find((m) => m.type === 'ice');
    assert.deepEqual(localIce, { v: 1, seq: localIce.seq, sentAt: localIce.sentAt, type: 'ice', sessionId: 's1', candidate: { candidate: 'local-cand' } });

    await FakeWebSocket.instance.emit({ v: 1, type: 'ice', sessionId: 's1', candidate: { candidate: 'remote-cand' } });
    await flush();
    assert.deepEqual(created[0].candidates, [{ candidate: 'remote-cand' }]);
});

test('P2PAnswerer reports connected and drops a peer on close', async () => {
    const created = [];
    const answerer = newAnswerer({}, created);
    answerer.start();
    await FakeWebSocket.instance.emit({ v: 1, type: 'offer', sessionId: 's1', sdp: 'O' });
    await flush();

    created[0].connectionState = 'connected';
    created[0].onconnectionstatechange();
    assert.ok(FakeWebSocket.instance.sent.some((m) => m.type === 'connected' && m.sessionId === 's1'));

    await FakeWebSocket.instance.emit({ v: 1, type: 'close', sessionId: 's1' });
    assert.equal(answerer.peerCount, 0);
    assert.equal(created[0].closed, true);
});

test('P2PAnswerer stop closes every peer and the socket', async () => {
    const created = [];
    const answerer = newAnswerer({}, created);
    answerer.start();
    await FakeWebSocket.instance.emit({ v: 1, type: 'offer', sessionId: 's1', sdp: 'O' });
    await flush();

    answerer.stop();
    assert.equal(created[0].closed, true);
    assert.equal(FakeWebSocket.instance.readyState, 3);
    assert.equal(answerer.peerCount, 0);
});

test('P2PAnswerer.replaceVideoTrack swaps the sender track on every peer', async () => {
    const created = [];
    const answerer = newAnswerer({}, created);
    answerer.start();
    await FakeWebSocket.instance.emit({ v: 1, type: 'offer', sessionId: 's1', sdp: 'O' });
    await flush();

    const replaced = [];
    created[0].getSenders = () => [{ track: { kind: 'video' }, replaceTrack(t) { replaced.push(t); } }];
    const newTrack = { kind: 'video', id: 'new' };
    answerer.replaceVideoTrack(newTrack);
    assert.deepEqual(replaced, [newTrack]);
});
