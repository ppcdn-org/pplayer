// PLY-013: consume the absolute timestamp ppobs embeds per frame and turn it
// into an end-to-end delay, using the PLY-014-calibrated clock from
// time-sync.mjs instead of raw Date.now(). Original wire format is the
// "obs-timestamp" WebRTC DataChannel JSON ppobs sends
// (ppobs/docs/obs-abs-timestamp-protocol.md §3):
// {"frame_no": <uint16 rtp seq>, "timestamp": <utc epoch ms>, "rid": "<simulcast layer>"}
//
// mmx does not forward this as a literal WebRTC DataChannel, though — Origin
// already receives it (ppmmx/internal/servers/webrtc/session.go
// onInboundDataChannel) and re-broadcasts it to WHEP readers as an
// `{"type":"OBS_TIMESTAMP","data":{frame_no,timestamp,rid}}` envelope over
// the same ABR control WebSocket ppplayer's MMXControlClient already opens
// (ppplayer.js), not a new channel. isValidObsTimestampMessage validates the
// already-JSON.parsed `data` object regardless of which envelope it arrived
// in.
//
// Scope note: ppobs only sends this over its WHIP connection to Origin (not
// over the direct P2P PeerConnection to a player), so this only ever fires
// for the edge path today; the P2P path relies on RTCP RTT instead (see
// docs/tech/P2P时延测量方案.md §4). It also only reaches viewers connected to
// Origin directly until Edge relays what it pulls from Origin onward
// (MMX-111/MMX-309 — Edge-side relay tracked separately).

export function isValidObsTimestampMessage(msg) {
    return !!msg
        && typeof msg === 'object'
        && Number.isFinite(msg.timestamp)
        && msg.timestamp > 0
        && Number.isInteger(msg.frame_no)
        && typeof msg.rid === 'string';
}

// nowMs must already be offset-corrected (TimeSync#now()); passing the
// raw/uncorrected clock defeats the entire point of PLY-014 and is how the
// original proposal ended up with spurious negative delays. null in ⇒ null
// out: the caller must not report anything before calibration completes.
export function computeDelayMs(nowMs, timestampMs) {
    if (nowMs === null || nowMs === undefined) return null;
    if (!Number.isFinite(timestampMs)) return null;
    return nowMs - timestampMs;
}
