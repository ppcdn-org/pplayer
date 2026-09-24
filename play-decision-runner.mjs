import { PlaybackRaceController } from './playback-race-controller.mjs?v=20260924-5';
import { EdgeWHEPPath, P2PPlaybackPath } from './playback-paths.mjs?v=20260924-5';

export function getEdgeFallbackUrl(decision) {
    if (!decision?.playUrl) {
        throw new Error('play decision does not include a playUrl');
    }
    return decision.playUrl;
}

export function createPlaybackRace(decision, {
    onSelected,
    onFailed,
    onTelemetry,
    ReaderClass,
    WebSocketClass,
    PeerConnectionClass,
    bufferMs = null,
    ControllerClass = PlaybackRaceController,
} = {}) {
    if (decision?.mode !== 'p2p-connect' || !decision.p2p) {
        throw new Error('play decision is not a P2P decision');
    }

    // Both legs get the same buffer length so the viewer sees the latency they
    // asked for regardless of which path ends up on screen. Edge is the default
    // and is shown immediately; P2P is a background upgrade the controller only
    // switches to after verifying it decodes (see PlaybackRaceController). The
    // decision's raceWindowMs/connectTimeoutMs described the old symmetric race
    // and no longer apply - the controller uses its own edge-primary timings.
    const edgePath = new EdgeWHEPPath({ url: getEdgeFallbackUrl(decision), ReaderClass, bufferMs });
    const p2pPath = new P2PPlaybackPath({ session: decision.p2p, WebSocketClass, PeerConnectionClass, bufferMs });
    const controller = new ControllerClass({
        edgePath,
        p2pPath,
        onSelected,
        onFailed,
        onTelemetry,
    });
    return { controller, edgePath, p2pPath };
}

export function startPlaybackFromDecision(decision, { startDirectStream, startRacedPlayback }) {
    if (decision?.mode === 'p2p-connect') {
        startRacedPlayback(decision);
        return 'p2p-connect';
    }
    if (decision?.mode === 'edge-only') {
        startDirectStream(getEdgeFallbackUrl(decision));
        return 'edge-only';
    }
    throw new Error('unsupported play decision mode');
}
