import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePlayRequest, requestPlayDecision } from '../play-request.mjs';

test('parses complete ppcenter query and generates client ID', () => {
    const config = parsePlayRequest('?ppcenter=https%3A%2F%2Fcenter.example&appId=app1&streamName=live&txTime=abc&txSecret=sig', () => 'generated');
    assert.equal(config.clientId, 'generated');
    assert.equal(config.streamName, 'live');
});

test('rejects partial ppcenter query', () => {
    assert.throws(() => parsePlayRequest('?ppcenter=https://center.example&streamName=live'), /provided together/);
});

test('returns null for direct WHEP mode', () => {
    assert.equal(parsePlayRequest('', () => 'unused'), null);
});

test('requests edge-only WHEP decision with exact authorization', async () => {
    let captured;
    const decision = { mode: 'edge-only', playUrl: 'https://edge.example/app/live/whep?txTime=1&txSecret=2' };
    const result = await requestPlayDecision({
        ppcenter: 'https://center.example/base', appId: 'app1', streamName: 'live',
        txTime: 'abc', txSecret: 'sig', clientId: 'viewer', requestRegion: 'Sydney', natProbeId: 'probe-1',
    }, { fetchImpl: async (url, options) => {
        captured = { url, options };
        return { ok: true, status: 200, json: async () => decision };
    }});
    assert.equal(captured.url, 'https://center.example/v1/play/requests');
    assert.equal(captured.options.headers.Authorization, 'Bearer app1:abc:sig');
    assert.deepEqual(JSON.parse(captured.options.body), {
        streamName: 'live', clientId: 'viewer', requestRegion: 'Sydney', capabilities: ['whep', 'p2p-h264-opus'], natProbeId: 'probe-1',
    });
    assert.equal(result.playUrl, decision.playUrl);
});

test('edge-only request drops the p2p capability when P2P is off', async () => {
    let captured;
    await requestPlayDecision({
        ppcenter: 'https://center.example', appId: 'app1', streamName: 'live',
        txTime: 'abc', txSecret: 'sig', clientId: 'viewer', requestRegion: '',
    }, { preferP2P: false, fetchImpl: async (url, options) => {
        captured = { url, options };
        return { ok: true, status: 200, json: async () => ({ mode: 'edge-only', playUrl: 'https://edge.example/app/live/whep' }) };
    }});
    assert.deepEqual(JSON.parse(captured.options.body).capabilities, ['whep']);
});

test('surfaces API error and rejects unsupported decisions', async () => {
    await assert.rejects(() => requestPlayDecision({
        ppcenter: 'https://center.example', appId: 'a', txTime: '1', txSecret: '2', streamName: 's', clientId: 'c', requestRegion: '',
    }, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: 'expired' }) }) }), /expired/);
    await assert.rejects(() => requestPlayDecision({
        ppcenter: 'https://center.example', appId: 'a', txTime: '1', txSecret: '2', streamName: 's', clientId: 'c', requestRegion: '',
    }, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ mode: 'invalid' }) }) }), /unsupported/);
});

test('passes through stunServers on a valid P2P decision', async () => {
    const result = await requestPlayDecision({
        ppcenter: 'https://center.example', appId: 'a', txTime: '1', txSecret: '2', streamName: 's', clientId: 'c', requestRegion: '',
    }, { fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            mode: 'p2p-connect',
            playUrl: 'https://edge.example/app/live/whep',
            p2p: {
                sessionId: 'session', signalUrl: 'wss://signal.example', token: 'token',
                raceWindowMs: 500, connectTimeoutMs: 2000, stunServers: ['stun:api.pp-cdn.org:3478'],
            },
        }),
    }) });
    assert.deepEqual(result.p2p.stunServers, ['stun:api.pp-cdn.org:3478']);
});

test('accepts a P2P decision with no stunServers at all', async () => {
    const result = await requestPlayDecision({
        ppcenter: 'https://center.example', appId: 'a', txTime: '1', txSecret: '2', streamName: 's', clientId: 'c', requestRegion: '',
    }, { fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            mode: 'p2p-connect',
            playUrl: 'https://edge.example/app/live/whep',
            p2p: { sessionId: 'session', signalUrl: 'wss://signal.example', token: 'token', raceWindowMs: 500, connectTimeoutMs: 2000 },
        }),
    }) });
    assert.equal(result.p2p.stunServers, undefined);
});

test('rejects P2P decisions with a malformed stunServers field', async () => {
    await assert.rejects(() => requestPlayDecision({
        ppcenter: 'https://center.example', appId: 'a', txTime: '1', txSecret: '2', streamName: 's', clientId: 'c', requestRegion: '',
    }, { fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            mode: 'p2p-connect',
            playUrl: 'https://edge.example/app/live/whep',
            p2p: {
                sessionId: 'session', signalUrl: 'wss://signal.example', token: 'token',
                raceWindowMs: 500, connectTimeoutMs: 2000, stunServers: 'stun:api.pp-cdn.org:3478',
            },
        }),
    }) }), /invalid P2P decision/);
});

test('rejects P2P decisions with invalid race timing', async () => {
    await assert.rejects(() => requestPlayDecision({
        ppcenter: 'https://center.example', appId: 'a', txTime: '1', txSecret: '2', streamName: 's', clientId: 'c', requestRegion: '',
    }, { fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            mode: 'p2p-connect',
            playUrl: 'https://edge.example/app/live/whep',
            p2p: { sessionId: 'session', signalUrl: 'wss://signal.example', token: 'token', raceWindowMs: 500, connectTimeoutMs: 500 },
        }),
    }) }), /invalid P2P decision/);
});
