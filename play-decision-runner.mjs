import { PlaybackRaceController } from './playback-race-controller.mjs?v=20260924-8';
import { EdgeWHEPPath, P2PPlaybackPath } from './playback-paths.mjs?v=20260924-8';

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
    enableVisibleTrial = true,
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
        enableVisibleTrial,
        onSelected,
        onFailed,
        onTelemetry,
    });
    return { controller, edgePath, p2pPath };
}

// Builds the direct (non-raced) P2P leg. Under the "ppcenter decides, no
// client-side racing" rule, a p2p-connect decision means the API already
// judged this pair traversable AND the publisher has a free slot, so playback
// connects P2P alone; the edge URL rides along only as a sequential
// failure fallback.
export function createDirectP2PPlayback(decision, { WebSocketClass, PeerConnectionClass, bufferMs = null } = {}) {
    if (decision?.mode !== 'p2p-connect' || !decision.p2p) {
        throw new Error('play decision is not a P2P decision');
    }
    return new P2PPlaybackPath({ session: decision.p2p, WebSocketClass, PeerConnectionClass, bufferMs });
}

export function startPlaybackFromDecision(decision, { startDirectStream, startP2PPlayback }) {
    if (decision?.mode === 'p2p-connect') {
        if (!startP2PPlayback) {
            throw new Error('p2p-connect decision requires startP2PPlayback');
        }
        startP2PPlayback(decision);
        return 'p2p-connect';
    }
    if (decision?.mode === 'edge-only') {
        startDirectStream(getEdgeFallbackUrl(decision));
        return 'edge-only';
    }
    throw new Error('unsupported play decision mode');
}
