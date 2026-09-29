// Builds the full WHEP URL for a ppcenter-issued edge stream base.
//
// ppcenter returns the bare edge stream base, e.g.
//   https://edge-1.edge.pp-cdn.org/{appId}/{streamName}
// with no codec segment, no /whep and no signature. The client appends the
// codec it can actually decode (see codec-capability.mjs) and the WHEP
// resource:
//   .../{stream}/hevc/whep  when HEVC is supported
//   .../{stream}/h264/whep  otherwise
//
// Idempotent for a URL that already carries a codec or /whep segment, so it is
// safe regardless of which shape the server hands back.
export function buildEdgeWhepUrl(edgeStreamUrl, codecType) {
    if (codecType !== 'h264' && codecType !== 'hevc') {
        throw new Error(`unsupported codecType: ${codecType}`);
    }
    const u = new URL(edgeStreamUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    const whepIndex = parts.lastIndexOf('whep');
    if (whepIndex >= 2 && (parts[whepIndex - 1] === 'h264' || parts[whepIndex - 1] === 'hevc')) {
        parts[whepIndex - 1] = codecType;      // already .../{codec}/whep
    } else if (whepIndex > 0) {
        parts.splice(whepIndex, 0, codecType); // .../whep, no codec segment
    } else {
        parts.push(codecType, 'whep');         // bare stream base
    }
    u.pathname = '/' + parts.join('/');
    return u.toString();
}
