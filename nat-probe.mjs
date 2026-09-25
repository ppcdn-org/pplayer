// ppcenter runs its own STUN server (internal/stun) on the same host as the
// API, conventionally at port 3478 - deriving it from `ppcenter` means the
// probe doesn't need ppcenter to have answered anything yet (it runs before
// the first request of any kind). Google's public STUN is raced alongside it
// as a reachability fallback: some networks can't reach ppcenter's own STUN
// at all (confirmed in production 2026-09-22 - a publisher's network that
// reached Google's STUN reliably every 4 minutes via ppobs's probe refresh
// got zero responses from ppcenter's own the moment Google was removed as a
// fallback), and a failed probe here means the whole attempt falls back to
// edge-only, so reachability matters more than which server answers.
//
// Racing two servers can make the publisher and a player each win against a
// *different* one and disagree on address family (api.pp-cdn.org has no
// AAAA record, so ppcenter's own can only ever answer IPv4; Google's
// typically answers whichever family the network prefers) - ppcenter's
// eligibility check rejects that pairing outright as address_family_mismatch
// (also confirmed in production 2026-09-22, as the failure mode right after
// fixing identity_mismatch). Handled below by resolving early only on an
// IPv4 srflx candidate specifically, from either server, rather than on
// whichever answers first - see the onicecandidate handler and
// pickProbeCandidate's ranking. See docs/test/ppcdn-debug-log.md's
// 2026-09-22 entry for the full trail.
//
// Note this two-server arrangement is browser-only and deliberately NOT
// mirrored in ppobs's nat-probe.cpp, even though the two files otherwise
// track each other closely: libdatachannel/libjuice uses only the first
// STUN entry and silently discards the rest, so the publisher side always
// probes against ppcenter's own alone. See that file's own comment.
function deriveStunIceServers(ppcenter) {
    const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
        const host = new URL(ppcenter).hostname;
        if (host) servers.unshift({ urls: `stun:${host}:3478` });
    } catch {
        // Malformed ppcenter URL - fall back to the public server alone;
        // requestPlayDecision will surface the same malformed URL as an
        // error shortly after anyway.
    }
    return servers;
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
            // Resolve as soon as an IPv4 server-reflexive candidate shows up
            // rather than waiting for every configured ICE server to finish
            // (the `candidate: null` end-of-gathering event) - srflx is
            // already pickProbeCandidate's top-ranked type, so nothing is
            // gained by continuing to wait once one is in hand, and waiting
            // means one slow/unreachable server holds up the whole probe
            // even though another one already answered (confirmed in
            // production 2026-09-22: with two configured ICE servers,
            // gathering still ran the full ~5s before this fix, one
            // confirmed-fast server notwithstanding).
            //
            // Specifically IPv4, not "any srflx": with two STUN servers
            // racing, an IPv6 candidate from whichever server answers first
            // must not short-circuit gathering before an IPv4 one (from
            // either server) has a chance to arrive - see
            // deriveStunIceServers's doc comment on address_family_mismatch.
            // If IPv4 never shows up before the timeout, pickProbeCandidate
            // still falls back to the best of whatever did arrive.
            const parts = event.candidate.type === 'srflx' ? candidateParts(event.candidate) : null;
            if (parts && !parts.ip.includes(':')) resolve();
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
        const data = await resp.json();
        // Attach the client's public IPv4 (from the srflx candidate) so the
        // caller can include it in its pull-stream report. Kept alongside the
        // ppcenter response fields (probeId etc.) so existing callers are
        // unaffected.
        const publicIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(chosen.ip || '') ? chosen.ip : '';
        return Object.assign({}, data, { ipv4: publicIpv4 });
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
