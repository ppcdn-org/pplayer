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
    // None supplied is the manual/direct-play page; all five is a signed P2P
    // link. Anything in between is a malformed link, and listing exactly
    // which params are absent makes it fixable instead of a guessing game.
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
        throw new Error(body?.message || `play request failed with status ${response.status}`);
    }
    if ((body?.mode !== 'edge-only' && body?.mode !== 'p2p-connect') || !body?.playUrl) {
        throw new Error('ppcenter returned an unsupported play decision');
    }
    if (body.mode === 'p2p-connect' && (!body.p2p?.sessionId || !body.p2p?.signalUrl || !body.p2p?.token ||
        !Number.isInteger(body.p2p.raceWindowMs) || body.p2p.raceWindowMs < 0 ||
        !Number.isInteger(body.p2p.connectTimeoutMs) || body.p2p.connectTimeoutMs <= body.p2p.raceWindowMs)) {
        throw new Error('ppcenter returned an invalid P2P decision');
    }
    const playUrl = new URL(body.playUrl);
    if (playUrl.protocol !== 'http:' && playUrl.protocol !== 'https:') {
        throw new Error('ppcenter returned an invalid WHEP URL');
    }
    return body;
}
