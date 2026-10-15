import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePlayRequest, requestPlayDecision, requestErtspPlayDecision, requestPlayDecisionWithRetry, isTransientPlayError } from '../play-request.mjs';

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
    const decision = { mode: 'edge-only', edgeStreamUrl: 'https://edge.example/app/live' };
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
    assert.equal(result.edgeStreamUrl, decision.edgeStreamUrl);
});

test('edge-only request drops the p2p capability when P2P is off', async () => {
    let captured;
    await requestPlayDecision({
        ppcenter: 'https://center.example', appId: 'app1', streamName: 'live',
        txTime: 'abc', txSecret: 'sig', clientId: 'viewer', requestRegion: '',
    }, { preferP2P: false, fetchImpl: async (url, options) => {
        captured = { url, options };
        return { ok: true, status: 200, json: async () => ({ mode: 'edge-only', edgeStreamUrl: 'https://edge.example/app/live' }) };
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
            edgeStreamUrl: 'https://edge.example/app/live',
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
            edgeStreamUrl: 'https://edge.example/app/live',
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
            edgeStreamUrl: 'https://edge.example/app/live',
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
            edgeStreamUrl: 'https://edge.example/app/live',
            p2p: { sessionId: 'session', signalUrl: 'wss://signal.example', token: 'token', raceWindowMs: 500, connectTimeoutMs: 500 },
        }),
    }) }), /invalid P2P decision/);
});

test('requestErtspPlayDecision sends only the ertsp capability, no P2P/natProbeId fields', async () => {
    let captured;
    const decision = { mode: 'edge-ertsp', edgeStreamUrl: 'rtsp://txtime:txsecret@edge.example:8554/app/live/h264' };
    const result = await requestErtspPlayDecision({
        ppcenter: 'https://center.example/base', appId: 'app1', streamName: 'live',
        txTime: 'abc', txSecret: 'sig', clientId: 'viewer', requestRegion: 'Sydney',
    }, { fetchImpl: async (url, options) => {
        captured = { url, options };
        return { ok: true, status: 200, json: async () => decision };
    }});
    assert.equal(captured.url, 'https://center.example/v1/play/requests');
    assert.equal(captured.options.headers.Authorization, 'Bearer app1:abc:sig');
    assert.deepEqual(JSON.parse(captured.options.body), {
        streamName: 'live', clientId: 'viewer', requestRegion: 'Sydney', capabilities: ['ertsp'],
    });
    assert.equal(result.edgeStreamUrl, decision.edgeStreamUrl);
});

test('requestErtspPlayDecision rejects a WHEP-shaped decision (wrong mode)', async () => {
    await assert.rejects(() => requestErtspPlayDecision({
        ppcenter: 'https://center.example', appId: 'a', txTime: '1', txSecret: '2', streamName: 's', clientId: 'c', requestRegion: '',
    }, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ mode: 'edge-only', edgeStreamUrl: 'https://edge.example/app/live' }) }) }),
    /unsupported/);
});

test('requestErtspPlayDecision rejects a non-rtsp edgeStreamUrl', async () => {
    await assert.rejects(() => requestErtspPlayDecision({
        ppcenter: 'https://center.example', appId: 'a', txTime: '1', txSecret: '2', streamName: 's', clientId: 'c', requestRegion: '',
    }, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ mode: 'edge-ertsp', edgeStreamUrl: 'https://edge.example/app/live' }) }) }),
    /invalid ERTSP stream URL/);
});

test('requestErtspPlayDecision surfaces the API error message', async () => {
    await assert.rejects(() => requestErtspPlayDecision({
        ppcenter: 'https://center.example', appId: 'a', txTime: '1', txSecret: '2', streamName: 's', clientId: 'c', requestRegion: '',
    }, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: 'expired' }) }) }),
    /expired/);
});

test('classifies only transient (503 / no_edge_available) play errors', () => {
    assert.equal(isTransientPlayError({ status: 503 }), true);
    assert.equal(isTransientPlayError({ code: 'no_edge_available' }), true);
    assert.equal(isTransientPlayError({ code: 'no_healthy_edge' }), true);
    assert.equal(isTransientPlayError(new Error('no healthy edge is available')), true);
    assert.equal(isTransientPlayError({ status: 401, message: 'expired' }), false);
    assert.equal(isTransientPlayError({ status: 400, code: 'invalid_request' }), false);
    assert.equal(isTransientPlayError(null), false);
});

test('requestPlayDecisionWithRetry retries a transient 503 then succeeds', async () => {
    let calls = 0;
    const retries = [];
    const decision = { mode: 'edge-only', edgeStreamUrl: 'https://edge.example/app/live' };
    const result = await requestPlayDecisionWithRetry({
        ppcenter: 'https://center.example', appId: 'app1', streamName: 'live',
        txTime: 'abc', txSecret: 'sig', clientId: 'viewer', requestRegion: '',
    }, {
        retryDelayMs: 0,
        onRetry: (attempt) => retries.push(attempt),
        fetchImpl: async () => {
            calls += 1;
            if (calls < 3) {
                return { ok: false, status: 503, json: async () => ({ code: 'no_edge_available', message: 'no healthy edge is available' }) };
            }
            return { ok: true, status: 200, json: async () => decision };
        },
    });
    assert.equal(calls, 3);
    assert.deepEqual(retries, [1, 2]);
    assert.equal(result.edgeStreamUrl, decision.edgeStreamUrl);
});

test('requestPlayDecisionWithRetry does not retry a non-transient failure', async () => {
    let calls = 0;
    await assert.rejects(() => requestPlayDecisionWithRetry({
        ppcenter: 'https://center.example', appId: 'a', txTime: '1', txSecret: '2', streamName: 's', clientId: 'c', requestRegion: '',
    }, {
        retryDelayMs: 0,
        fetchImpl: async () => { calls += 1; return { ok: false, status: 401, json: async () => ({ message: 'expired' }) }; },
    }), /expired/);
    assert.equal(calls, 1);
});

test('requestPlayDecisionWithRetry gives up after maxAttempts on a persistent 503', async () => {
    let calls = 0;
    await assert.rejects(() => requestPlayDecisionWithRetry({
        ppcenter: 'https://center.example', appId: 'a', txTime: '1', txSecret: '2', streamName: 's', clientId: 'c', requestRegion: '',
    }, {
        maxAttempts: 3,
        retryDelayMs: 0,
        fetchImpl: async () => { calls += 1; return { ok: false, status: 503, json: async () => ({ code: 'no_edge_available', message: 'no healthy edge is available' }) }; },
    }), /no healthy edge/);
    assert.equal(calls, 3);
});

test('requestPlayDecisionWithRetry stops immediately once the signal is aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(() => requestPlayDecisionWithRetry({
        ppcenter: 'https://center.example', appId: 'a', txTime: '1', txSecret: '2', streamName: 's', clientId: 'c', requestRegion: '',
    }, {
        signal: controller.signal,
        retryDelayMs: 0,
        fetchImpl: async () => {
            calls += 1;
            controller.abort();
            return { ok: false, status: 503, json: async () => ({ code: 'no_edge_available', message: 'no healthy edge is available' }) };
        },
    }));
    assert.equal(calls, 1);
});
