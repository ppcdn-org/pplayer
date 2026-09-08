export async function probeNATAndSubmit({ ppcenter, appId, txTime, txSecret, clientId, streamName }) {
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceTransportPolicy: 'all',
    });
    pc.createDataChannel('probe');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const candidates = [];
    const icePromise = new Promise((resolve) => {
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                candidates.push(event.candidate);
            } else {
                resolve();
            }
        };
        setTimeout(resolve, 5000);
    });
    await icePromise;
    pc.close();

    const srflx = candidates.find((c) => c.type === 'srflx' || c.type === 'host');
    if (!srflx) return null;

    const [ip, portStr] = srflx.address ? [srflx.address, srflx.port] : parseCandidateAddress(srflx.candidate);
    if (!ip) return null;

    const natType = srflx.type === 'srflx' ? 'restricted' : 'public';
    const body = {
        kind: streamName ? 'publisher' : 'player',
        clientId,
        natType,
        publicIp: ip,
        publicPort: parseInt(portStr, 10) || 0,
    };
    if (streamName) body.streamName = streamName;
    if (appId) body.appId = appId;

    const headers = {
        'Content-Type': 'application/json',
    };
    if (txTime && txSecret && appId) {
        headers['Authorization'] = `Bearer ${appId}:${txTime}:${txSecret}`;
    }

    try {
        const resp = await fetch(new URL('/v1/nat/probe', ppcenter).toString(), {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

function parseCandidateAddress(candidate) {
    const parts = candidate.split(' ');
    for (let i = 4; i < parts.length - 1; i++) {
        if (parts[i].match(/^\d+\.\d+\.\d+\.\d+$/)) {
            return [parts[i], parseInt(parts[i + 1], 10)];
        }
    }
    return [];
}
