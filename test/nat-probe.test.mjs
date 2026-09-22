import assert from 'node:assert/strict';
import test from 'node:test';

class FakeRTCPeerConnection {
    constructor(config) {
        this.config = config;
        this.onicecandidate = null;
        this._gathered = false;
        FakeRTCPeerConnection.latest = this;
    }
    createDataChannel() {}
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async setLocalDescription() {}
    close() {}
    gather(candidates) {
        if (!this.onicecandidate) return;
        for (const c of candidates) this.onicecandidate({ candidate: c });
        if (!this._gathered) { this._gathered = true; this.onicecandidate({ candidate: null }); }
    }
}

let capturedURL, capturedBody, capturedHeaders;

async function mockFetch(url, options) {
    capturedURL = url;
    capturedBody = JSON.parse(options.body);
    capturedHeaders = options.headers;
    return { ok: true, status: 200, json: async () => ({ probeId: 'probe-test-client', natType: 'restricted', directlyReachable: false }) };
}

test('NAT probe gathers srflx candidate and submits to ppcenter', async () => {
    const { probeNATAndSubmit } = await import('../nat-probe.mjs');
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    globalThis.fetch = mockFetch;

    const probePromise = probeNATAndSubmit({
        ppcenter: 'https://center.example',
        appId: 'app123',
        txTime: 'abc',
        txSecret: 'sig',
        clientId: 'test-client',
        streamName: 'live',
    });

    await new Promise(r => setTimeout(r, 10));
    FakeRTCPeerConnection.latest.gather([{ type: 'srflx', address: '203.0.113.5', port: 54321, candidate: '' }]);
    const result = await probePromise;

    assert.equal(result.probeId, 'probe-test-client');
    assert.equal(capturedURL, 'https://center.example/v1/nat/probe');
    assert.equal(capturedBody.natType, 'restricted');
    assert.equal(capturedBody.publicIp, '203.0.113.5');
    assert.equal(capturedBody.publicPort, 54321);
    assert.equal(capturedBody.kind, 'publisher');
    assert.equal(capturedHeaders.Authorization, 'Bearer app123:abc:sig');
});

test('NAT probe falls back to candidate string parsing without address', async () => {
    const { probeNATAndSubmit } = await import('../nat-probe.mjs');
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    globalThis.fetch = mockFetch;

    const probePromise = probeNATAndSubmit({
        ppcenter: 'https://center.example',
        appId: 'app123',
        txTime: 'abc',
        txSecret: 'sig',
        clientId: 'client',
    });

    await new Promise(r => setTimeout(r, 10));
    FakeRTCPeerConnection.latest.gather([{ type: 'srflx', candidate: 'candidate:1 1 UDP 2122252543 198.51.100.7 12345 typ srflx' }]);
    const result = await probePromise;

    assert.equal(result.probeId, 'probe-test-client');
    assert.equal(capturedBody.natType, 'restricted');
    assert.equal(capturedBody.publicIp, '198.51.100.7');
    assert.equal(capturedBody.publicPort, 12345);
    assert.equal(capturedBody.kind, 'player');
});

test('NAT probe skips mDNS host candidates and prefers the srflx address', async () => {
    const { probeNATAndSubmit } = await import('../nat-probe.mjs');
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    globalThis.fetch = mockFetch;

    const probePromise = probeNATAndSubmit({
        ppcenter: 'https://center.example',
        appId: 'app123',
        clientId: 'viewer',
    });

    await new Promise(r => setTimeout(r, 10));
    FakeRTCPeerConnection.latest.gather([
        { type: 'host', address: '8642ef70-a937.local', port: 50000, candidate: 'candidate:1 1 udp 2113 8642ef70-a937.local 50000 typ host' },
        { type: 'srflx', address: '138.84.153.1', port: 25657, candidate: '' },
    ]);
    const result = await probePromise;

    assert.equal(result.probeId, 'probe-test-client');
    assert.equal(capturedBody.publicIp, '138.84.153.1');
    assert.equal(capturedBody.publicPort, 25657);
    assert.equal(capturedBody.natType, 'restricted');
    assert.equal(capturedBody.kind, 'player');
});

test('NAT probe honours an explicit kind while keeping streamName for auth', async () => {
    const { probeNATAndSubmit } = await import('../nat-probe.mjs');
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    globalThis.fetch = mockFetch;

    const probePromise = probeNATAndSubmit({
        ppcenter: 'https://center.example',
        appId: 'app123',
        txTime: 'abc',
        txSecret: 'sig',
        clientId: 'viewer',
        streamName: 'B01-frontView',
        kind: 'player',
    });

    await new Promise(r => setTimeout(r, 10));
    FakeRTCPeerConnection.latest.gather([{ type: 'srflx', address: '138.84.153.1', port: 25657, candidate: '' }]);
    await probePromise;

    assert.equal(capturedBody.kind, 'player');
    assert.equal(capturedBody.streamName, 'B01-frontView');
    assert.equal(capturedBody.publicIp, '138.84.153.1');
});

test('NAT probe strips IPv6 brackets from the address', async () => {
    const { probeNATAndSubmit } = await import('../nat-probe.mjs');
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    globalThis.fetch = mockFetch;

    const probePromise = probeNATAndSubmit({
        ppcenter: 'https://center.example',
        appId: 'app123',
        clientId: 'viewer',
    });

    await new Promise(r => setTimeout(r, 10));
    FakeRTCPeerConnection.latest.gather([{ type: 'srflx', address: '[2001:db8::1]', port: 40000, candidate: '' }]);
    const result = await probePromise;

    assert.equal(capturedBody.publicIp, '2001:db8::1');
    assert.equal(capturedBody.natType, 'restricted');
});

test('NAT probe returns null when only mDNS host candidates are available', async () => {
    const { probeNATAndSubmit } = await import('../nat-probe.mjs');
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    globalThis.fetch = mockFetch;

    const probePromise = probeNATAndSubmit({
        ppcenter: 'https://center.example',
        appId: 'app123',
        clientId: 'viewer',
    });

    await new Promise(r => setTimeout(r, 10));
    FakeRTCPeerConnection.latest.gather([
        { type: 'host', address: 'abcd.local', port: 50000, candidate: 'candidate:1 1 udp 2113 abcd.local 50000 typ host' },
    ]);
    assert.equal(await probePromise, null);
});

test('NAT probe returns null when fetch fails', async () => {
    const { probeNATAndSubmit } = await import('../nat-probe.mjs');
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    globalThis.fetch = async () => { throw new Error('network'); };

    const probePromise = probeNATAndSubmit({
        ppcenter: 'https://center.example',
        appId: 'app123',
        clientId: 'client',
    });

    await new Promise(r => setTimeout(r, 10));
    FakeRTCPeerConnection.latest.gather([{ type: 'srflx', address: '1.2.3.4', port: 9 }]);
    assert.equal(await probePromise, null);
});

test('NAT probe tries ppcenter\'s own STUN server first, Google STUN as fallback', async () => {
    const { probeNATAndSubmit } = await import('../nat-probe.mjs');
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    globalThis.fetch = mockFetch;

    const probePromise = probeNATAndSubmit({
        ppcenter: 'https://api.pp-cdn.org',
        appId: 'app123',
        clientId: 'viewer',
    });

    assert.deepEqual(FakeRTCPeerConnection.latest.config.iceServers, [
        { urls: 'stun:api.pp-cdn.org:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
    ]);

    await new Promise(r => setTimeout(r, 10));
    FakeRTCPeerConnection.latest.gather([{ type: 'srflx', address: '138.84.153.1', port: 25657, candidate: '' }]);
    await probePromise;
});

test('NAT probe falls back to Google STUN alone when ppcenter is not a valid URL', async () => {
    const { probeNATAndSubmit } = await import('../nat-probe.mjs');
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    globalThis.fetch = mockFetch;

    const probePromise = probeNATAndSubmit({
        ppcenter: 'not-a-url',
        appId: 'app123',
        clientId: 'viewer',
    });

    assert.deepEqual(FakeRTCPeerConnection.latest.config.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);

    await new Promise(r => setTimeout(r, 10));
    FakeRTCPeerConnection.latest.gather([{ type: 'srflx', address: '138.84.153.1', port: 25657, candidate: '' }]);
    await probePromise;
});

test('NAT probe resolves on the first srflx candidate without waiting for gathering to finish', async () => {
    const { probeNATAndSubmit } = await import('../nat-probe.mjs');
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    globalThis.fetch = mockFetch;

    const probePromise = probeNATAndSubmit({
        ppcenter: 'https://center.example',
        appId: 'app123',
        clientId: 'viewer',
    });

    await new Promise(r => setTimeout(r, 10));
    // Only fires the srflx candidate - no `candidate: null` end-of-gathering
    // event ever arrives (simulates a second configured ICE server that
    // never finishes). Before this fix probeNATAndSubmit would have hung
    // here until the 5000ms ceiling; it must now resolve immediately.
    if (!FakeRTCPeerConnection.latest.onicecandidate) throw new Error('onicecandidate not set');
    FakeRTCPeerConnection.latest.onicecandidate({
        candidate: { type: 'srflx', address: '138.84.153.1', port: 25657, candidate: '' },
    });
    const result = await probePromise;

    assert.equal(result.probeId, 'probe-test-client');
    assert.equal(capturedBody.publicIp, '138.84.153.1');
});

test('NAT probe times out gracefully without candidates', async () => {
    const { probeNATAndSubmit } = await import('../nat-probe.mjs');
    globalThis.RTCPeerConnection = FakeRTCPeerConnection;
    let timedOut = false;
    const orig = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => { if (ms === 5000) timedOut = true; return orig(fn, 0); };

    const result = await probeNATAndSubmit({
        ppcenter: 'https://center.example',
        appId: 'app123',
        clientId: 'client',
    });

    assert.equal(result, null);
    assert.ok(timedOut);
    globalThis.setTimeout = orig;
});
