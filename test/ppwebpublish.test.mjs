import assert from 'node:assert/strict';
import test from 'node:test';

import {
    preferH264Order,
    detectPublishVideoCodec,
    requestBrowserPublishSession,
    refreshBrowserPublishSession,
    stopBrowserPublishSession,
    probeBrowserPublisherNat,
    whipPublish,
    buildAbsTimestampNAL,
    injectAbsTimestampSEI,
    attachAbsTimestampInjector,
    DEFAULT_SIMULCAST_LAYERS,
    BrowserPublisher,
} from '../ppwebpublish.mjs';
import { findObsAbsTimestamp } from '../sei-timestamp.mjs';

const H264_MODE1 = { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' };
const H264_MODE0 = { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=0' };
const VP8 = { mimeType: 'video/VP8' };
const VP9 = { mimeType: 'video/VP9' };
const AV1 = { mimeType: 'video/AV1' };

test('preferH264Order ranks H264/packetization-mode=1, then H264/mode 0, then the rest', () => {
    const ordered = preferH264Order([VP8, H264_MODE0, VP9, H264_MODE1, AV1]);
    assert.deepEqual(ordered, [H264_MODE1, H264_MODE0, VP8, VP9, AV1]);
});

test('preferH264Order preserves the relative order of non-H264 codecs', () => {
    const ordered = preferH264Order([AV1, VP9, VP8]);
    assert.deepEqual(ordered, [AV1, VP9, VP8]);
});

function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => body };
}

test('requestBrowserPublishSession posts appId/streamName with the user JWT', async () => {
    const calls = [];
    const decision = { sessionId: 'bp_1', whipUrl: 'https://origin/x/h264/whip', bearerToken: 'tok', expiresAt: '2030-01-01T00:00:00Z' };
    const result = await requestBrowserPublishSession(
        { ppcenter: 'https://api.pp-cdn.org', token: 'jwt-123', appId: 'app123', streamName: 'live-001' },
        { fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse(decision); } },
    );
    assert.deepEqual(result, decision);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.pp-cdn.org/v1/publish/browser-requests');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer jwt-123');
    assert.deepEqual(JSON.parse(calls[0].init.body), { appId: 'app123', streamName: 'live-001' });
});

test('requestBrowserPublishSession surfaces the error code from an error envelope', async () => {
    await assert.rejects(
        requestBrowserPublishSession(
            { ppcenter: 'https://api.pp-cdn.org', token: 'jwt', appId: 'app123', streamName: 'live' },
            { fetchImpl: async () => jsonResponse({ code: 'app_forbidden', message: 'no' }, { ok: false, status: 403 }) },
        ),
        (error) => {
            assert.equal(error.code, 'app_forbidden');
            assert.equal(error.status, 403);
            return true;
        },
    );
});

test('refreshBrowserPublishSession hits the session refresh route', async () => {
    const calls = [];
    await refreshBrowserPublishSession(
        { ppcenter: 'https://api.pp-cdn.org', token: 'jwt', appId: 'app123', streamName: 'live' },
        'bp_1',
        { fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse({}); } },
    );
    assert.equal(calls[0].url, 'https://api.pp-cdn.org/v1/publish/browser-requests/bp_1/refresh');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer jwt');
});

test('stopBrowserPublishSession treats a 404 as already-stopped', async () => {
    await assert.doesNotReject(stopBrowserPublishSession(
        { ppcenter: 'https://api.pp-cdn.org', token: 'jwt' },
        'bp_1',
        { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ code: 'session_not_found' }) }) },
    ));
});

test('stopBrowserPublishSession throws on a real failure', async () => {
    await assert.rejects(stopBrowserPublishSession(
        { ppcenter: 'https://api.pp-cdn.org', token: 'jwt' },
        'bp_1',
        { fetchImpl: async () => jsonResponse({ code: 'session_store_unavailable' }, { ok: false, status: 503 }) },
    ));
});

function fakePeerConnection() {
    return {
        iceGatheringState: 'complete',
        localDescription: null,
        addEventListener() {},
        removeEventListener() {},
        addTransceiver(track) { return { track }; },
        async createOffer() { return { type: 'offer', sdp: 'OFFER_SDP' }; },
        async setLocalDescription(offer) { this.localDescription = offer; },
        async setRemoteDescription(answer) { this.remoteDescription = answer; },
        close() { this.closed = true; },
    };
}

test('whipPublish posts the offer with the bearer token and applies the answer', async () => {
    const pc = fakePeerConnection();
    const calls = [];
    const location = await whipPublish(
        { whipUrl: 'https://origin/app123/live-001/h264/whip', bearerToken: 'whip-tok' },
        pc,
        {
            fetchImpl: async (url, init) => {
                calls.push({ url, init });
                return { ok: true, status: 201, text: async () => 'ANSWER_SDP', headers: { get: (k) => (k === 'Location' ? '/resource/1' : null) } };
            },
        },
    );
    assert.equal(location, '/resource/1');
    assert.equal(calls[0].url, 'https://origin/app123/live-001/h264/whip');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer whip-tok');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/sdp');
    assert.equal(calls[0].init.body, 'OFFER_SDP');
    assert.deepEqual(pc.remoteDescription, { type: 'answer', sdp: 'ANSWER_SDP' });
});

test('whipPublish throws when the Origin rejects the offer', async () => {
    await assert.rejects(
        whipPublish(
            { whipUrl: 'https://origin/x/whip', bearerToken: 'tok' },
            fakePeerConnection(),
            { fetchImpl: async () => ({ ok: false, status: 406 }) },
        ),
        /WHIP publish failed with status 406/,
    );
});

test('BrowserPublisher.start publishes then stop tears everything down', async () => {
    const states = [];
    const video = { kind: 'video', stopped: false, stop() { this.stopped = true; } };
    const audio = { kind: 'audio', stopped: false, stop() { this.stopped = true; } };
    const stream = { getTracks: () => [video, audio] };
    const pcs = [];
    const fetchCalls = [];
    const decision = {
        sessionId: 'bp_1',
        whipUrl: 'https://origin/app123/live-001/h264/whip',
        bearerToken: 'tok',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const publisher = new BrowserPublisher({
        ppcenter: 'https://api.pp-cdn.org',
        token: 'jwt',
        appId: 'app123',
        streamName: 'live-001',
        getUserMedia: async () => stream,
        createPeerConnection: () => { const pc = fakePeerConnection(); pcs.push(pc); return pc; },
        onState: (state) => states.push(state),
        fetchImpl: async (url, init) => {
            fetchCalls.push({ url, init });
            if (url.endsWith('/v1/publish/browser-requests')) return jsonResponse(decision);
            if (url === decision.whipUrl) return { ok: true, status: 201, text: async () => 'ANSWER', headers: { get: () => null } };
            return jsonResponse({}); // DELETE stop
        },
    });

    const started = await publisher.start();
    assert.equal(started.sessionId, 'bp_1');
    assert.deepEqual(states, ['requesting-session', 'capturing', 'publishing', 'live']);
    assert.equal(pcs.length, 1);
    assert.equal(pcs[0].closed, undefined);
    assert.equal(fetchCalls[0].url, 'https://api.pp-cdn.org/v1/publish/browser-requests');

    await publisher.stop();
    assert.equal(pcs[0].closed, true);
    assert.equal(video.stopped, true);
    assert.equal(audio.stopped, true);
    assert.equal(states.at(-1), 'stopped');
    const stopCall = fetchCalls.find((c) => c.init.method === 'DELETE');
    assert.equal(stopCall.url, 'https://api.pp-cdn.org/v1/publish/browser-requests/bp_1');
});

function annexBFrame(payloadBytes) {
    return new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, ...payloadBytes]);
}

test('buildAbsTimestampNAL round-trips through the reader pplayer already uses', () => {
    for (const ts of [0, 1, 1_800_000_000_000, 281_474_976_710_655]) {
        const nal = buildAbsTimestampNAL(ts);
        const auframe = new Uint8Array([0x00, 0x00, 0x00, 0x01, ...nal]);
        assert.equal(findObsAbsTimestamp(auframe, 'h264'), ts, `ts=${ts}`);
    }
});

test('injectAbsTimestampSEI prepends a parsable SEI and keeps the original NALs', () => {
    const original = annexBFrame([0x88, 0x99]);
    const injected = injectAbsTimestampSEI(original, 123_456);
    assert.notEqual(injected, original);
    assert.equal(findObsAbsTimestamp(injected, 'h264'), 123_456);
    // The original IDR start code + NAL must still be present at the tail.
    assert.deepEqual(injected.subarray(injected.length - original.length), original);
});

test('injectAbsTimestampSEI leaves a non-Annex-B frame untouched', () => {
    const avcc = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x88]);
    assert.equal(injectAbsTimestampSEI(avcc, 999), avcc);
});

test('attachAbsTimestampInjector stamps every frame with the anchored wall clock', async () => {
    const input = new TransformStream();
    const output = new TransformStream();
    const sender = { createEncodedStreams: () => ({ readable: input.readable, writable: output.writable }) };
    const attached = attachAbsTimestampInjector(sender, { now: () => 1_000 });
    assert.equal(attached, true);

    const writer = input.writable.getWriter();
    const reader = output.readable.getReader();
    await writer.write({ timestamp: 0, data: annexBFrame([0x88]).buffer });
    await writer.write({ timestamp: 2_000, data: annexBFrame([0x88]).buffer });

    const first = await reader.read();
    const second = await reader.read();
    assert.equal(findObsAbsTimestamp(new Uint8Array(first.value.data), 'h264'), 1_000);
    // 2000µs after the anchor = 2ms -> 1002ms.
    assert.equal(findObsAbsTimestamp(new Uint8Array(second.value.data), 'h264'), 1_002);
});

test('attachAbsTimestampInjector is a no-op on senders without Insertable Streams', () => {
    assert.equal(attachAbsTimestampInjector({}), false);
    assert.equal(attachAbsTimestampInjector({ createEncodedStreams: () => { throw new Error('nope'); } }), false);
});

test('BrowserPublisher applies the H264 simulcast ladder when simulcast:true', async () => {
    const added = [];
    const stream = { getTracks: () => [{ kind: 'video', stop() {} }] };
    const decision = {
        sessionId: 'bp_1', whipUrl: 'https://origin/app/live/h264/whip', bearerToken: 't',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const publisher = new BrowserPublisher({
        ppcenter: 'https://api.pp-cdn.org', token: 'jwt', appId: 'app', streamName: 'live',
        simulcast: true,
        getUserMedia: async () => stream,
        createPeerConnection: () => ({
            iceGatheringState: 'complete', localDescription: null,
            addEventListener() {}, removeEventListener() {},
            addTransceiver(track, options) { added.push(options); return { sender: {} }; },
            async createOffer() { return { type: 'offer', sdp: 'O' }; },
            async setLocalDescription(offer) { this.localDescription = offer; },
            async setRemoteDescription() {},
            close() {},
        }),
        fetchImpl: async (url) => (url.endsWith('/v1/publish/browser-requests')
            ? jsonResponse(decision)
            : { ok: true, status: 201, text: async () => 'A', headers: { get: () => null } }),
    });

    await publisher.start();
    assert.equal(added.length, 1);
    assert.deepEqual(added[0].sendEncodings, DEFAULT_SIMULCAST_LAYERS);
    await publisher.stop();
});

test('detectPublishVideoCodec defaults to h264 without RTCRtpSender', () => {
    assert.equal(detectPublishVideoCodec(), 'h264');
});

test('requestBrowserPublishSession includes codec when set', async () => {
    const calls = [];
    await requestBrowserPublishSession(
        { ppcenter: 'https://api.pp-cdn.org', token: 'jwt', appId: 'app123', streamName: 'live', codec: 'vp8' },
        { fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse({}); } },
    );
    assert.deepEqual(JSON.parse(calls[0].init.body), { appId: 'app123', streamName: 'live', codec: 'vp8' });
});

test('BrowserPublisher on VP8 requests codec=vp8 and skips the H264 simulcast ladder', async () => {
    const added = [];
    const fetchCalls = [];
    const stream = { getTracks: () => [{ kind: 'video', stop() {} }] };
    const decision = {
        sessionId: 'bp_vp8', codec: 'vp8', whipUrl: 'https://origin/app/live/whip', bearerToken: 't',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const publisher = new BrowserPublisher({
        ppcenter: 'https://api.pp-cdn.org', token: 'jwt', appId: 'app', streamName: 'live',
        codec: 'vp8', simulcast: true,
        getUserMedia: async () => stream,
        createPeerConnection: () => ({
            iceGatheringState: 'complete', localDescription: null,
            addEventListener() {}, removeEventListener() {},
            addTransceiver(track, options) { added.push(options); return { sender: {} }; },
            async createOffer() { return { type: 'offer', sdp: 'O' }; },
            async setLocalDescription(offer) { this.localDescription = offer; },
            async setRemoteDescription() {},
            close() {},
        }),
        fetchImpl: async (url, init) => {
            fetchCalls.push({ url, init });
            return url.endsWith('/v1/publish/browser-requests')
                ? jsonResponse(decision)
                : { ok: true, status: 201, text: async () => 'A', headers: { get: () => null } };
        },
    });

    await publisher.start();
    assert.equal(added.length, 1);
    assert.equal(added[0].sendEncodings, undefined);
    assert.equal(JSON.parse(fetchCalls[0].init.body).codec, 'vp8');
    await publisher.stop();
});

class FakeAnswerer {
    static instances = [];
    constructor(opts) { this.opts = opts; this.started = false; this.stopped = false; FakeAnswerer.instances.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
}

function publishingFetch(decision, fetchCalls) {
    return async (url, init) => {
        fetchCalls.push({ url, init });
        if (url.endsWith('/v1/publish/browser-requests')) return jsonResponse(decision);
        if (url === decision.whipUrl) return { ok: true, status: 201, text: async () => 'A', headers: { get: () => null } };
        return jsonResponse({}); // DELETE stop
    };
}

test('BrowserPublisher opts into P2P and starts the answerer when a signal is returned', async () => {
    FakeAnswerer.instances = [];
    const fetchCalls = [];
    const stream = { getTracks: () => [{ kind: 'video', stop() {} }, { kind: 'audio', stop() {} }] };
    const decision = {
        sessionId: 'bp_p2p', codec: 'h264', whipUrl: 'https://origin/app/live/h264/whip', bearerToken: 't',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        signal: { signalUrl: 'wss://signal.example/v1/p2p/signal', token: 'sig-tok', participantId: 'publisher-1' },
        stunServers: ['stun:api.pp-cdn.org:3478'], maxP2PSessions: 3,
    };
    const publisher = new BrowserPublisher({
        ppcenter: 'https://api.pp-cdn.org', token: 'jwt', appId: 'app', streamName: 'live',
        p2p: true, natProbe: { clientId: 'c1', natProbeId: 'pr1' },
        getUserMedia: async () => stream,
        createPeerConnection: () => fakePeerConnection(),
        P2PAnswererClass: FakeAnswerer,
        fetchImpl: publishingFetch(decision, fetchCalls),
    });

    await publisher.start();
    const body = JSON.parse(fetchCalls[0].init.body);
    assert.deepEqual({ enableP2P: body.enableP2P, clientId: body.clientId, natProbeId: body.natProbeId },
        { enableP2P: true, clientId: 'c1', natProbeId: 'pr1' });

    assert.equal(FakeAnswerer.instances.length, 1);
    const answerer = FakeAnswerer.instances[0];
    assert.equal(answerer.started, true);
    assert.equal(answerer.opts.mediaStream, stream);
    assert.equal(answerer.opts.session.maxPeers, 3);
    assert.deepEqual(answerer.opts.session.stunServers, ['stun:api.pp-cdn.org:3478']);

    await publisher.stop();
    assert.equal(answerer.stopped, true);
});

test('BrowserPublisher does not request P2P without a NAT probe', async () => {
    const fetchCalls = [];
    const stream = { getTracks: () => [{ kind: 'video', stop() {} }] };
    const decision = {
        sessionId: 'bp', codec: 'h264', whipUrl: 'https://origin/app/live/h264/whip', bearerToken: 't',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const publisher = new BrowserPublisher({
        ppcenter: 'https://api.pp-cdn.org', token: 'jwt', appId: 'app', streamName: 'live',
        p2p: true, autoNatProbe: false, // no natProbe supplied and auto-probe off
        getUserMedia: async () => stream,
        createPeerConnection: () => fakePeerConnection(),
        P2PAnswererClass: FakeAnswerer,
        fetchImpl: publishingFetch(decision, fetchCalls),
    });

    await publisher.start();
    assert.equal(JSON.parse(fetchCalls[0].init.body).enableP2P, undefined);
    await publisher.stop();
});

test('probeBrowserPublisherNat registers a publisher observation', async () => {
    const calls = [];
    const result = await probeBrowserPublisherNat(
        { ppcenter: 'https://api.pp-cdn.org', token: 'jwt', appId: 'app123', streamName: 'live', clientId: 'c1' },
        {
            gather: async () => ({ natType: 'restricted', publicIp: '203.0.113.7', publicPort: 40000 }),
            fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse({ probeId: 'probe-x' }); },
        },
    );
    assert.equal(result.clientId, 'c1');
    assert.equal(result.natProbeId, 'probe-x');
    assert.equal(calls[0].url, 'https://api.pp-cdn.org/v1/publish/browser-probe');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer jwt');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
        appId: 'app123', streamName: 'live', clientId: 'c1',
        natType: 'restricted', publicIp: '203.0.113.7', publicPort: 40000,
    });
});

test('probeBrowserPublisherNat returns null when nothing was gathered', async () => {
    const result = await probeBrowserPublisherNat(
        { ppcenter: 'https://api.pp-cdn.org', token: 't', appId: 'a', streamName: 's' },
        { gather: async () => null, fetchImpl: async () => { throw new Error('should not fetch'); } },
    );
    assert.equal(result, null);
});

test('BrowserPublisher auto-probes NAT for P2P when none is supplied', async () => {
    FakeAnswerer.instances = [];
    const fetchCalls = [];
    const probeCalls = [];
    const stream = { getTracks: () => [{ kind: 'video', stop() {} }] };
    const decision = {
        sessionId: 'bp_auto', codec: 'h264', whipUrl: 'https://origin/app/live/h264/whip', bearerToken: 't',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        signal: { signalUrl: 'wss://signal.example/x', token: 'st', participantId: 'p' },
        stunServers: [], maxP2PSessions: 2,
    };
    const publisher = new BrowserPublisher({
        ppcenter: 'https://api.pp-cdn.org', token: 'jwt', appId: 'app', streamName: 'live',
        p2p: true,
        probeNat: async (config) => { probeCalls.push(config); return { clientId: 'c9', natProbeId: 'p9' }; },
        getUserMedia: async () => stream,
        createPeerConnection: () => fakePeerConnection(),
        P2PAnswererClass: FakeAnswerer,
        fetchImpl: publishingFetch(decision, fetchCalls),
    });

    await publisher.start();
    assert.equal(probeCalls.length, 1);
    const body = JSON.parse(fetchCalls[0].init.body);
    assert.deepEqual(
        { enableP2P: body.enableP2P, clientId: body.clientId, natProbeId: body.natProbeId },
        { enableP2P: true, clientId: 'c9', natProbeId: 'p9' },
    );
    assert.equal(FakeAnswerer.instances.length, 1);
    await publisher.stop();
});
