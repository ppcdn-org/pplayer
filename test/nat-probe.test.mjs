import assert from 'node:assert/strict';
import test from 'node:test';

class FakeRTCPeerConnection {
    constructor() {
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
