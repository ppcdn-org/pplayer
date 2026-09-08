import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlaybackRace, getEdgeFallbackUrl, startPlaybackFromDecision } from '../play-decision-runner.mjs';

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

test('creates race controller using center-provided timing and paths', () => {
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
    assert.equal(playback.controller.options.raceWindowMs, 750);
    assert.equal(playback.controller.options.connectTimeoutMs, 2500);
    assert.equal(playback.controller.options.onSelected, selected);
    assert.equal(playback.controller.options.onFailed, failed);
    assert.equal(playback.controller.options.onTelemetry, telemetry);
});

test('rejects non-P2P decisions for race creation', () => {
    assert.throws(() => createPlaybackRace({ mode: 'edge-only', playUrl: p2pDecision.playUrl }, { ControllerClass: FakeController }), /not a P2P/);
});

test('starts Edge directly for edge-only decisions without creating race', () => {
    const calls = [];
    const mode = startPlaybackFromDecision({ mode: 'edge-only', playUrl: p2pDecision.playUrl }, {
        startDirectStream: (url) => calls.push(['edge', url]),
        startRacedPlayback: () => calls.push(['race']),
    });

    assert.equal(mode, 'edge-only');
    assert.deepEqual(calls, [['edge', p2pDecision.playUrl]]);
});

test('starts P2P race for p2p-connect decisions', () => {
    const calls = [];
    const mode = startPlaybackFromDecision(p2pDecision, {
        startDirectStream: (url) => calls.push(['edge', url]),
        startRacedPlayback: (decision) => calls.push(['race', decision]),
    });

    assert.equal(mode, 'p2p-connect');
    assert.deepEqual(calls, [['race', p2pDecision]]);
});
