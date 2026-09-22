// ppcenter runs its own STUN server (internal/stun) on the same host as the
// API, conventionally at port 3478 - deriving it from `ppcenter` means the
// probe doesn't need ppcenter to have answered anything yet (it runs before
// the first request of any kind).
//
// Deliberately the *only* STUN server, not one of a race against a public
// fallback (e.g. Google's) - two servers with different address-family
// reachability (api.pp-cdn.org has no AAAA record; a public STUN provider
// typically does) meant the publisher and a player could each win their own
// race against a *different* server and come back with different address
// families (one IPv4, one IPv6), which ppcenter's eligibility check rejects
// outright as address_family_mismatch - confirmed in production 2026-09-22
// as the failure mode right after fixing every earlier one. Using only
// ppcenter's own (IPv4-only) server makes both sides' results consistent by
// construction. A failed/slow probe here already falls back to edge-only
// exactly like today - this isn't a new failure mode, just no longer papered
// over by a second server that could disagree with the first. See
// docs/test/ppcdn-debug-log.md's 2026-09-22 entry.
function deriveStunIceServers(ppcenter) {
    try {
        const host = new URL(ppcenter).hostname;
        if (host) return [{ urls: `stun:${host}:3478` }];
    } catch {
        // Malformed ppcenter URL - requestPlayDecision will surface the same
        // malformed URL as an error shortly after anyway.
    }
    return [];
}

export async function probeNATAndSubmit({ ppcenter, appId, txTime, txSecret, clientId, streamName, kind }) {
    const pc = new RTCPeerConnection({
        iceServers: deriveStunIceServers(ppcenter),
        iceTransportPolicy: 'all',
    });
    pc.createDataChannel('probe');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const candidates = [];
    const icePromise = new Promise((resolve) => {
        pc.onicecandidate = (event) => {
            if (!event.candidate) {
                resolve();
                return;
            }
            candidates.push(event.candidate);
            // Resolve as soon as a server-reflexive candidate shows up
            // rather than waiting for every configured ICE server to
            // finish (the `candidate: null` end-of-gathering event) -
            // srflx is already pickProbeCandidate's top-ranked type, so
            // nothing is gained by continuing to wait, and waiting here
            // means one slow/unreachable server (e.g. a public STUN
            // fallback on a network where it's throttled) holds up the
            // whole probe even though another one already answered.
            // Confirmed in production 2026-09-22: with two configured ICE
            // servers, gathering still ran the full ~5s before this fix,
            // one confirmed-fast server notwithstanding - see
            // docs/test/ppcdn-debug-log.md's 2026-09-22 entry.
            if (event.candidate.type === 'srflx') resolve();
        };
        setTimeout(resolve, 5000);
    });
    await icePromise;
    pc.close();

    const chosen = pickProbeCandidate(candidates);
    if (!chosen) return null;

    // A server-reflexive address means we are behind a NAT whose exact type
    // the browser cannot see (it can't tell full-cone from port-restricted),
    // so report the conservative "restricted". A real (non-mDNS) host address
    // means the machine is directly reachable.
    const natType = chosen.type === 'srflx' ? 'restricted' : 'public';
    const body = {
        // kind is explicit: the viewer's probe is a "player" observation even
        // though it still carries streamName, which ppcenter needs only to
        // verify the viewer token (the token is signed over appId/streamName).
        kind: kind || (streamName ? 'publisher' : 'player'),
        clientId,
        natType,
        publicIp: chosen.ip,
        publicPort: chosen.port,
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

// Chrome mDNS-obfuscates host candidates to "<uuid>.local" - a name the
// server cannot dial - and ICE candidate .address is not always present, so
// take a real IP literal from either field and never report a hostname.
function normalizeIp(value) {
    if (!value) return '';
    let ip = String(value).trim();
    if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1); // IPv6 literal
    if (ip.toLowerCase().endsWith('.local')) return '';
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    if (ip.includes(':')) return ip; // IPv6
    return '';
}

function candidateParts(candidate) {
    const fromAddress = normalizeIp(candidate.address);
    if (fromAddress) return { ip: fromAddress, port: Number(candidate.port) || 0 };
    const parts = String(candidate.candidate || '').split(' ');
    for (let i = 4; i < parts.length - 1; i++) {
        const ip = normalizeIp(parts[i]);
        if (ip) return { ip, port: parseInt(parts[i + 1], 10) || 0 };
    }
    return null;
}

// Prefer what the far side can actually reach: IPv4 server-reflexive, then
// any server-reflexive, then a real (non-mDNS) host address.
function pickProbeCandidate(candidates) {
    const resolved = [];
    for (const candidate of candidates) {
        const parts = candidateParts(candidate);
        if (parts && parts.port > 0) resolved.push({ ...parts, type: candidate.type });
    }
    const rank = (c) => {
        const ipv4 = !c.ip.includes(':');
        if (c.type === 'srflx' && ipv4) return 0;
        if (c.type === 'srflx') return 1;
        if (ipv4) return 2;
        return 3;
    };
    resolved.sort((a, b) => rank(a) - rank(b));
    return resolved[0] || null;
}
