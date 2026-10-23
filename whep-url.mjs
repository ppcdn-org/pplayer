// pplayer pulls streams over WHEP only. A stream is addressed either by a WHEP
// URL ("https://<edge>/{appId}/{streamName}[/{h264|hevc}]/whep") or, in the
// Stream box, by "appId/streamName". Other pull formats (HLS, FLV, RTMP, SRT,
// RTSP ...) are not played: say so instead of feeding them to the WHEP reader.

export const WHEP_ONLY_MESSAGE =
    'pplayer only plays WHEP streams. Use a WHEP URL (ending in /whep) or enter appId/streamName; '
    + 'HLS, FLV, RTMP, SRT and other URLs are not supported.';

// True for an http(s) URL whose path is {appId}/{streamName}[/{codec}]/whep.
export function isWhepUrl(raw) {
    try {
        const u = new URL(String(raw || '').trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const parts = u.pathname.split('/').filter(Boolean);
        return parts.length >= 3 && parts[parts.length - 1] === 'whep';
    } catch {
        return false;
    }
}

// True when the text is a URL (scheme://...) rather than an appId/streamName.
export function looksLikeUrl(raw) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(raw || '').trim());
}
