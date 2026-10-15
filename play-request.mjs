export function parsePlayRequest(search, randomUUID = () => crypto.randomUUID()) {
    const params = new URLSearchParams(search);
    const config = {
        ppcenter: params.get('ppcenter')?.trim() || '',
        appId: params.get('appId')?.trim() || '',
        streamName: params.get('streamName')?.trim() || '',
        txTime: params.get('txTime')?.trim() || '',
        txSecret: params.get('txSecret')?.trim() || '',
        clientId: params.get('clientId')?.trim() || randomUUID(),
        requestRegion: params.get('requestRegion')?.trim() || '',
        natProbeId: params.get('natProbeId')?.trim() || '',
    };
    const required = ['ppcenter', 'appId', 'streamName', 'txTime', 'txSecret'];
    const missing = required.filter((key) => !config[key]);
    // All five is a signed link; a partial one is a malformed link, and listing
    // exactly which params are absent makes it fixable instead of a guessing
    // game. None at all is still reported as null so the caller can surface a
    // link notice (there is no manual/direct-play mode any more).
    if (missing.length !== 0 && missing.length !== required.length) {
        throw new Error(
            'ppcenter, appId, streamName, txTime and txSecret must be provided together' +
            ` (missing: ${missing.join(', ')})`);
    }
    return missing.length === 0 ? config : null;
}

export async function requestPlayDecision(config, { fetchImpl = fetch, signal, natProbeId, preferP2P = true } = {}) {
    const endpoint = new URL('/v1/play/requests', config.ppcenter).toString();
    // Without the p2p capability ppcenter answers edge-only, which is exactly
    // what the unchecked P2P box should do.
    const capabilities = preferP2P ? ['whep', 'p2p-h264-opus'] : ['whep'];
    const response = await fetchImpl(endpoint, {
        method: 'POST',
        signal,
        headers: {
            'Authorization': `Bearer ${config.appId}:${config.txTime}:${config.txSecret}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            streamName: config.streamName,
            clientId: config.clientId,
            requestRegion: config.requestRegion,
            capabilities,
            ...(config.natProbeId || natProbeId ? { natProbeId: natProbeId || config.natProbeId } : {}),
        }),
    });
    let body;
    try {
        body = await response.json();
    } catch {
        body = null;
    }
    if (!response.ok) {
        const error = new Error(body?.message || `play request failed with status ${response.status}`);
        // Carry the wire status/code so a caller can tell a transient
        // "edge not ready yet" apart from a real auth/validation failure
        // (see isTransientPlayError / requestPlayDecisionWithRetry).
        error.status = response.status;
        if (body?.code) error.code = body.code;
        throw error;
    }
    if ((body?.mode !== 'edge-only' && body?.mode !== 'p2p-connect') || !body?.edgeStreamUrl) {
        throw new Error('ppcenter returned an unsupported play decision');
    }
    // stunServers is optional (ppcenter omits it when its own STUN server
    // isn't configured) - absent is fine, present-but-malformed is not.
    if (body.mode === 'p2p-connect' && (!body.p2p?.sessionId || !body.p2p?.signalUrl || !body.p2p?.token ||
        !Number.isInteger(body.p2p.raceWindowMs) || body.p2p.raceWindowMs < 0 ||
        !Number.isInteger(body.p2p.connectTimeoutMs) || body.p2p.connectTimeoutMs <= body.p2p.raceWindowMs ||
        (body.p2p.stunServers !== undefined && !Array.isArray(body.p2p.stunServers)))) {
        throw new Error('ppcenter returned an invalid P2P decision');
    }
    const edgeStreamUrl = new URL(body.edgeStreamUrl);
    if (edgeStreamUrl.protocol !== 'http:' && edgeStreamUrl.protocol !== 'https:') {
        throw new Error('ppcenter returned an invalid edge stream URL');
    }
    return body;
}

// requestErtspPlayDecision is requestPlayDecision's ERTSP counterpart, kept
// separate rather than folded into it: ERTSP never attempts P2P (no NAT
// probe, no capability toggle) and its decision shape is deliberately
// different - mode "edge-ertsp" and an rtsp:// edgeStreamUrl, which
// requestPlayDecision's validation above rejects on purpose (it only ever
// expects the WHEP contract: "edge-only"/"p2p-connect" and an http(s) URL).
export async function requestErtspPlayDecision(config, { fetchImpl = fetch, signal } = {}) {
    const endpoint = new URL('/v1/play/requests', config.ppcenter).toString();
    const response = await fetchImpl(endpoint, {
        method: 'POST',
        signal,
        headers: {
            'Authorization': `Bearer ${config.appId}:${config.txTime}:${config.txSecret}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            streamName: config.streamName,
            clientId: config.clientId,
            requestRegion: config.requestRegion,
            capabilities: ['ertsp'],
        }),
    });
    let body;
    try {
        body = await response.json();
    } catch {
        body = null;
    }
    if (!response.ok) {
        throw new Error(body?.message || `play request failed with status ${response.status}`);
    }
    if (body?.mode !== 'edge-ertsp' || !body?.edgeStreamUrl) {
        throw new Error('ppcenter returned an unsupported play decision');
    }
    const edgeStreamUrl = new URL(body.edgeStreamUrl);
    if (edgeStreamUrl.protocol !== 'rtsp:') {
        throw new Error('ppcenter returned an invalid ERTSP stream URL');
    }
    return body;
}

// ppcenter answers 503 no_edge_available while a stream's Origin is momentarily
// not reporting it. The common cause is benign: a publisher reconnecting or
// switching transport leaves the Origin with no live path for a few seconds,
// and ppcenter only learns the new pipeline set on the node's next heartbeat
// (every 10s). Retrying is exactly right there - the stream is up again a
// moment later - while a genuinely offline stream just exhausts the attempts
// and reports the same error as before. Only this transient class is retried;
// auth/validation failures (401/403/400, ...) throw on the first attempt.
export const PLAY_REQUEST_MAX_ATTEMPTS = 6;
export const PLAY_REQUEST_RETRY_DELAY_MS = 2000;

export function isTransientPlayError(error) {
    if (!error) return false;
    if (error.status === 503) return true;
    if (error.code === 'no_edge_available' || error.code === 'no_healthy_edge') return true;
    // Older ppcenter bodies carry no status/code on the error - fall back to
    // the message text so the retry still engages.
    return /no healthy edge/i.test(error.message || '');
}

export async function requestPlayDecisionWithRetry(config, {
    signal,
    natProbeId,
    preferP2P = true,
    fetchImpl,
    maxAttempts = PLAY_REQUEST_MAX_ATTEMPTS,
    retryDelayMs = PLAY_REQUEST_RETRY_DELAY_MS,
    onRetry = null,
} = {}) {
    // Abort-aware delay: a stop/switch while waiting resolves the wait
    // immediately so the loop can observe the aborted signal and bail out
    // instead of holding the request open for the full backoff.
    const delay = (ms) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        }
    });

    for (let attempt = 1; ; attempt++) {
        try {
            return await requestPlayDecision(config, { signal, natProbeId, preferP2P, fetchImpl });
        } catch (error) {
            if (error?.name === 'AbortError' || signal?.aborted) throw error;
            if (!isTransientPlayError(error) || attempt >= maxAttempts) throw error;
            if (onRetry) onRetry(attempt, error);
            await delay(retryDelayMs);
            if (signal?.aborted) throw error;
        }
    }
}
