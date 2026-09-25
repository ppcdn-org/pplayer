import assert from 'node:assert/strict';
import test from 'node:test';

import { createDirectP2PPlayback, createPlaybackRace, getEdgeFallbackUrl, startPlaybackFromDecision } from '../play-decision-runner.mjs';

class FakeController {
    constructor(options) {
        this.options = options;
    }
}

const p2pDecision = {
    mode: 'p2p-connect',
    playUrl: 'https://edge.example/app/live/whep?txTime=1&txSecret=2',
    p2p: {
        sessionId: 'session-1',
        signalUrl: 'wss://center.example/v1/p2p/signal',
        token: 'token-1',
        raceWindowMs: 750,
        connectTimeoutMs: 2500,
    },
};

test('extracts Edge play URL from play decision', () => {
    assert.equal(getEdgeFallbackUrl(p2pDecision), p2pDecision.playUrl);
    assert.throws(() => getEdgeFallbackUrl({}), /playUrl/);
});

test('wires the edge/P2P paths and callbacks into the controller', () => {
    const selected = () => {};
    const failed = () => {};
    const telemetry = () => {};
    const playback = createPlaybackRace(p2pDecision, {
        ControllerClass: FakeController,
        onSelected: selected,
        onFailed: failed,
        onTelemetry: telemetry,
    });

    assert.equal(playback.edgePath.url, p2pDecision.playUrl);
    assert.equal(playback.p2pPath.session, p2pDecision.p2p);
    assert.equal(playback.controller.options.edgePath, playback.edgePath);
    assert.equal(playback.controller.options.p2pPath, playback.p2pPath);
    assert.equal(playback.controller.options.onSelected, selected);
    assert.equal(playback.controller.options.onFailed, failed);
    assert.equal(playback.controller.options.onTelemetry, telemetry);
    // The old symmetric-race timings are no longer passed to the controller
    // (it uses its own edge-primary timings).
    assert.equal(playback.controller.options.raceWindowMs, undefined);
    assert.equal(playback.controller.options.connectTimeoutMs, undefined);
});

test('rejects non-P2P decisions for race creation', () => {
    assert.throws(() => createPlaybackRace({ mode: 'edge-only', playUrl: p2pDecision.playUrl }, { ControllerClass: FakeController }), /not a P2P/);
});

test('builds a direct (non-raced) P2P leg from a p2p-connect decision', () => {
    const path = createDirectP2PPlayback(p2pDecision, {});
    assert.equal(path.session, p2pDecision.p2p);
    assert.throws(() => createDirectP2PPlayback({ mode: 'edge-only', playUrl: p2pDecision.playUrl }, {}), /not a P2P/);
});

test('starts Edge directly for edge-only decisions without touching P2P', () => {
    const calls = [];
    const mode = startPlaybackFromDecision({ mode: 'edge-only', playUrl: p2pDecision.playUrl }, {
        startDirectStream: (url) => calls.push(['edge', url]),
        startP2PPlayback: () => calls.push(['p2p']),
    });

    assert.equal(mode, 'edge-only');
    assert.deepEqual(calls, [['edge', p2pDecision.playUrl]]);
});

test('starts direct P2P (not a race) for p2p-connect decisions', () => {
    const calls = [];
    const mode = startPlaybackFromDecision(p2pDecision, {
        startDirectStream: (url) => calls.push(['edge', url]),
        startP2PPlayback: (decision) => calls.push(['p2p', decision]),
    });

    assert.equal(mode, 'p2p-connect');
    assert.deepEqual(calls, [['p2p', p2pDecision]]);
});
