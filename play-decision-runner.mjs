import { PlaybackRaceController } from './playback-race-controller.mjs?v=20260922-1';
import { EdgeWHEPPath, P2PPlaybackPath } from './playback-paths.mjs?v=20260922-1';

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
    canSwitchToP2P,
    ReaderClass,
    WebSocketClass,
    PeerConnectionClass,
    bufferMs = null,
    ControllerClass = PlaybackRaceController,
} = {}) {
    if (decision?.mode !== 'p2p-connect' || !decision.p2p) {
        throw new Error('play decision is not a P2P decision');
    }

    // Both legs get the same buffer length: whichever wins the race, the
    // viewer should see the latency they asked for, not one that depends on
    // which path happened to connect first.
    const edgePath = new EdgeWHEPPath({ url: getEdgeFallbackUrl(decision), ReaderClass, bufferMs });
    const p2pPath = new P2PPlaybackPath({ session: decision.p2p, WebSocketClass, PeerConnectionClass, bufferMs });
    const controller = new ControllerClass({
        edgePath,
        p2pPath,
        raceWindowMs: decision.p2p.raceWindowMs,
        connectTimeoutMs: decision.p2p.connectTimeoutMs,
        onSelected,
        onFailed,
        onTelemetry,
        canSwitchToP2P,
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
