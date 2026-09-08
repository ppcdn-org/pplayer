// main.js - Adapted for tx UI
// Supports both tx HTML (#player-container-id, #quality-select)
// and legacy mmx HTML (#video, #layerSelect)

const urlInput = document.getElementById('webrtc') || document.getElementById('urlInput');
const video = document.getElementById('player-container-id') || document.getElementById('video');
const statsContainer = document.querySelector('#local-video .stat ul') || document.getElementById('stats');
const layerSelect = document.getElementById('quality-select') || document.getElementById('layerSelect');
const wsStatusDot = document.getElementById('wsStatus');
// ppcenter base URL, entered by hand like the WHEP URL. Used only for clock
// calibration (see time-sync.js); playback works without it, just without a
// trustworthy P2P Delay reading.
const PPCENTER_DEFAULT_URL = 'http://127.0.0.1:18000';
const ppcenterInput = document.getElementById('ppcenterInput');
(() => {
    if (!wsStatusDot) {
        const dot = document.createElement('span');
        dot.id = 'wsStatus';
        dot.style.cssText = 'position:fixed;top:10px;right:10px;width:12px;height:12px;border-radius:50%;z-index:9999';
        document.body.appendChild(dot);
    }
    if (!urlInput) {
        const inp = document.createElement('input');
        inp.id = 'webrtc';
        inp.type = 'text';
        inp.value = 'http://localhost:8889/live/table1-fwv/whep';
        inp.style.display = 'none';
        document.body.appendChild(inp);
    }
})();

function ppcenterUrl() {
    const v = ppcenterInput && ppcenterInput.value ? ppcenterInput.value.trim() : '';
    return v || PPCENTER_DEFAULT_URL;
}

// HEVC/H264 multitrack simulcast (see
// docs/design/whip-hevc-h264-multitrack-simulcast-design.zh-CN.md §4.4):
// pplayer picks a codecType before the WHEP handshake ever starts, since
// H264 and HEVC live on two entirely independent WHIP/WHEP sessions
// server-side - there's no way to switch codec mid-session the way ABR
// switches simulcast layers.
//
// codecType is a URL *path segment* (".../h264/whep" or ".../hevc/whep"),
// inserted right before the trailing "whep" - see the design doc's §3.1.
// A URL with no codecType segment (the pre-multitrack shape) is left
// untouched: ppcenter/ppmmx both interpret that as "h264" (§6.2 default),
// so there is nothing to add when H264 is what got selected anyway.
function insertCodecTypeSegment(whepUrl, codecType) {
    if (codecType !== 'h264' && codecType !== 'hevc') return whepUrl;
    const u = new URL(whepUrl);
    const parts = u.pathname.split('/');
    const whepIndex = parts.lastIndexOf('whep');
    if (whepIndex <= 0) return whepUrl; // not a recognizable WHEP URL - leave it alone
    // Idempotent: replaces an existing codecType segment (h264<->hevc
    // fallback re-navigation) rather than accumulating one on retry.
    if (whepIndex >= 2 && (parts[whepIndex - 1] === 'h264' || parts[whepIndex - 1] === 'hevc')) {
        parts[whepIndex - 1] = codecType;
    } else {
        parts.splice(whepIndex, 0, codecType);
    }
    u.pathname = parts.join('/');
    return u.toString();
}

// The inverse of insertCodecTypeSegment - strips a codecType segment back
// out, used only for the one-shot HEVC->H264 fallback (see
// negotiateAndConnect) so the retry doesn't keep stacking segments.
function stripCodecTypeSegment(whepUrl) {
    try {
        const u = new URL(whepUrl);
        const parts = u.pathname.split('/');
        const whepIndex = parts.lastIndexOf('whep');
        if (whepIndex >= 2 && (parts[whepIndex - 1] === 'h264' || parts[whepIndex - 1] === 'hevc')) {
            parts.splice(whepIndex - 1, 1);
            u.pathname = parts.join('/');
            return u.toString();
        }
    } catch (e) { /* not a valid absolute URL - fall through */ }
    return whepUrl;
}

let reader = null;
let readerGeneration = 0;
let seiReaderAttached = false;
let controlClient = null;
let statsInterval = null;
let lastStats = { videoBytes: 0, audioBytes: 0, timestamp: 0 };
let previousTrackType = null; // Track if we were in audio-only mode
let lastVideoTrackId = null;
// Which codec path (see insertCodecTypeSegment above) the active session is
// using - drives the status display and tells attachSeiTimestampReader
// which NAL framing to parse (see sei-timestamp.js).
let activePlaybackCodec = 'h264';
// HEVC/H264 multitrack §4.4 "播放失败降级": a HEVC session that fails to
// negotiate falls back to H264 exactly once per startStream() call, so a
// server that's misconfigured for both codecs can't cause an infinite
// reconnect loop bouncing between them.
let hevcFallbackUsed = false;

// Codec names taken straight off the negotiated transceivers. getStats() only
// emits a "codec" report for a track once media has actually been received on
// it, and mmx pauses the audio track server-side whenever the ABR engine drops
// to a video-only layer (SET_MEDIA_STATE), so audio can sit with no codec
// report for long stretches - which is what left the Audio panel stuck on
// "N/A". The negotiated parameters are known from the moment the answer is
// applied and don't depend on packets flowing, so they're the reliable source;
// the live stats are still preferred when present, since they name the codec
// actually in use rather than merely negotiated.
let negotiatedCodecs = { audio: null, video: null };

// Reads the codec each receiver negotiated, e.g. "audio/opus" -> "opus".
function readNegotiatedCodecs(pc) {
    const out = { audio: null, video: null };
    if (!pc || typeof pc.getReceivers !== 'function') return out;
    for (const r of pc.getReceivers()) {
        const kind = r.track && r.track.kind;
        if (kind !== 'audio' && kind !== 'video') continue;
        // getParameters() on a receiver isn't available in every browser.
        let codecs = null;
        try {
            codecs = r.getParameters && r.getParameters().codecs;
        } catch (e) { /* not supported here */ }
        if (!codecs || !codecs.length) continue;
        // Skip the auxiliary payload types (retransmission, forward error
        // correction, DTMF); they're negotiated alongside the real codec but
        // aren't what's carrying the media.
        const main = codecs.find(c => {
            const sub = String(c.mimeType || '').split('/')[1] || '';
            return !/^(rtx|red|ulpfec|flexfec|CN|telephone-event)$/i.test(sub);
        }) || codecs[0];
        const sub = String(main.mimeType || '').split('/')[1];
        if (sub) out[kind] = sub;
    }
    return out;
}

// p2p delay: local render time minus the timestamp the OBS publisher
// embedded when it sent the frame (see docs/obs-abs-timestamp-protocol.md
// in the OBS repo). Two independent sources feed the same displayed value:
//
// 1. SEI (sei-timestamp.js): read directly out of the encoded H.264
//    bitstream via WebCodecs Insertable Streams. Survives mmx-to-mmx
//    cascading (no server-side relay needed) and is inherently correct
//    for whatever layer is actually being decoded. Chromium-only.
// 2. DataChannel relay (OBS_TIMESTAMP over the ABR control WebSocket, see
//    obs_timestamp_broadcast.go in mmx): only valid for a direct
//    OBS->mmx->player hop (no cascading), and needs manual rid matching
//    since it carries every simulcast layer's messages. Kept as a
//    fallback for non-Chromium browsers where SEI reading isn't available.
//
// SEI takes priority whenever both are reporting fresh values.
let lastP2PDelayMs = null;
let lastP2PDelayAt = 0;
let lastP2PDelaySource = null; // 'sei' | 'datachannel'
const P2P_DELAY_STALE_MS = 5000;
// Measured delay is a floor (rounding always trends it low, never high) -
// pad it so displayed numbers don't read as falsely great.
const P2P_DELAY_ERROR_MARGIN_MS = 50;
// Both ends of the subtraction must share a clock base: the timestamp comes
// from ppobs's NTP-disciplined clock, so the local side has to be corrected
// by the ppcenter offset (see time-sync.js) before subtracting. Until that
// first calibration lands we don't compute a delay at all rather than
// publishing a number built on an unknown clock skew.
let timeSync = null;
// Even with calibration, a badly wrong clock (or a stale offset after
// ppcenter has been unreachable for a while) can still produce impossible
// values. Real p2p delay is never under ~100ms - encode, network and jitter
// buffer alone exceed that - and never anywhere near 60s, since no WebRTC
// jitter buffer holds minutes of media. Anything outside this band is a
// clock artifact, not a delay, so fall back to the RTT/jitter-buffer
// estimate rather than showing a nonsensical number. The upper bound
// matters: without it, positive skew (e.g. the ~145s seen when ppobs
// anchored its timestamps to a drifting monotonic clock) got printed
// verbatim while negative skew was correctly caught.
const P2P_DELAY_CLOCK_SUSPECT_MS = 100;
const P2P_DELAY_MAX_PLAUSIBLE_MS = 60000;

function reportP2PDelay(timestampMs, source) {
    // SEI is strictly more accurate (in-band, cascade-safe, no rid
    // ambiguity) - once it's reporting, ignore stale DataChannel values.
    if (source === 'datachannel' && lastP2PDelaySource === 'sei' &&
        (Date.now() - lastP2PDelayAt) < P2P_DELAY_STALE_MS) {
        return;
    }
    // No calibrated clock yet => no delay. Deliberately not falling back to
    // a raw Date.now(): that's what produced the bogus readings this whole
    // mechanism exists to fix.
    const correctedNow = timeSync ? timeSync.now() : null;
    if (correctedNow === null) return;

    lastP2PDelayMs = correctedNow - Number(timestampMs) + P2P_DELAY_ERROR_MARGIN_MS;
    lastP2PDelayAt = Date.now();
    lastP2PDelaySource = source;

    // Only report plausible values upstream; see the bounds above.
    if (timeSync && lastP2PDelayMs >= P2P_DELAY_CLOCK_SUSPECT_MS &&
        lastP2PDelayMs <= P2P_DELAY_MAX_PLAUSIBLE_MS) {
        timeSync.reportLatency('edge', lastP2PDelayMs);
    }
}

// 实例化 ABR 引擎
const abrEngine = new ABREngine({
    onSwitchLayer: (trackId, reason) => {
        if (controlClient) {
            console.log(`[Main] ABR Triggered Switch: ${trackId} (${reason})`);
            switchMediaTrack(trackId, reason);
        }
    }
});

function switchMediaTrack(trackId, reason) {
    if (!controlClient) return;
    if (trackId === abrEngine.audioTrackId) {
        if (abrEngine.videoTrackIds.includes(abrEngine.currentTrackId)) lastVideoTrackId = abrEngine.currentTrackId;
        controlClient.setMediaState({ video: 'paused', audio: 'resumed' });
        abrEngine.notifyLayerSwitched(trackId);
        previousTrackType = 'audio';
        return;
    }
    if (trackId === abrEngine.currentTrackId && !videoPaused) {
        console.log(`[Main] Ignore redundant layer switch: ${trackId} (${reason})`);
        return;
    }
    lastVideoTrackId = trackId;
    if (videoPaused) {
        // Audio-only pauses video but keeps the selector on the last video
        // layer. Resume media first; select only when the target differs.
        controlClient.setMediaState({ video: 'resumed' });
        videoPaused = false;
        if (trackId === lastVideoTrackId) {
            abrEngine.notifyLayerSwitched(trackId);
            previousTrackType = 'video';
            return;
        }
    }
    controlClient.selectLayer(trackId, reason);
}

// [修复] 视频分辨率监控：增加判重逻辑
let lastWidth = 0;
let lastHeight = 0;

video.addEventListener('resize', () => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    
    // 如果尺寸没变，忽略（过滤掉 metadata 加载或浏览器内部重绘触发的 resize）
    if (w === lastWidth && h === lastHeight) return;
    
    lastWidth = w;
    lastHeight = h;

    const msg = `[Video] Resolution Changed: ${w}x${h}`;
    console.log(`%c${msg}`, 'background: #222; color: #bada55; font-size: 16px; padding: 4px; border-radius: 4px;');
    // showToast(msg);
});

video.addEventListener('loadedmetadata', () => {
    console.log(`[Video] Metadata loaded. Initial size: ${video.videoWidth}x${video.videoHeight}`);
});

// ✅ NEW: Monitor video state for debugging
video.addEventListener('waiting', () => {
    console.log('[Video] State: WAITING (buffering)');
});

video.addEventListener('playing', () => {
    console.log('[Video] State: PLAYING');
});

video.addEventListener('pause', () => {
    console.log('[Video] State: PAUSED');
});

function showToast(text) {
    const toast = document.createElement('div');
    toast.innerText = text;
    toast.style.cssText = `
        position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
        background: rgba(40, 167, 69, 0.9); color: white; padding: 10px 20px;
        border-radius: 20px; font-weight: bold; z-index: 1000; transition: opacity 0.5s;
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
    }, 3000);
}

document.getElementById('startPlay') || document.getElementById('startBtn').addEventListener('click', startStream);
document.getElementById('stopPlay') || document.getElementById('exitBtn').addEventListener('click', stopStream);
let videoPauseBtn = document.getElementById("videoPauseBtn");
if (!videoPauseBtn) {
    videoPauseBtn = document.createElement("a");
    videoPauseBtn.id = "videoPauseBtn";
    videoPauseBtn.className = "waves-effect waves-light btn-small orange";
    videoPauseBtn.textContent = "⏸";
    videoPauseBtn.title = "Pause Video";
    const stopBtn = document.getElementById("stopPlay");
    if (stopBtn && stopBtn.parentNode) stopBtn.parentNode.insertBefore(videoPauseBtn, stopBtn);
}
let audioPauseBtn = document.getElementById("audioPauseBtn");
if (!audioPauseBtn) {
    audioPauseBtn = document.createElement("a");
    audioPauseBtn.id = "audioPauseBtn";
    audioPauseBtn.className = "waves-effect waves-light btn-small orange";
    audioPauseBtn.textContent = "⏸";
    audioPauseBtn.title = "Pause Audio";
    const stopBtn = document.getElementById("stopPlay");
    if (stopBtn && stopBtn.parentNode) stopBtn.parentNode.insertBefore(audioPauseBtn, stopBtn);
}
let muteBtn = document.getElementById("muteBtn");
if (!muteBtn) {
    muteBtn = document.createElement("a");
    muteBtn.id = "muteBtn";
    muteBtn.className = "waves-effect waves-light btn-small orange";
    const stopBtn = document.getElementById("stopPlay");
    if (stopBtn && stopBtn.parentNode) stopBtn.parentNode.insertBefore(muteBtn, stopBtn);
}
let snapshotBtn = document.getElementById("snapshotBtn");
if (!snapshotBtn) {
    snapshotBtn = document.createElement("a");
    snapshotBtn.id = "snapshotBtn";
    snapshotBtn.className = "waves-effect waves-light btn-small orange";
    snapshotBtn.textContent = "\u{1F4F7}";
    snapshotBtn.title = "Snapshot";
    const stopBtn = document.getElementById("stopPlay");
    if (stopBtn && stopBtn.parentNode) stopBtn.parentNode.insertBefore(snapshotBtn, stopBtn);
}
let recordBtn = document.getElementById("recordBtn");
if (!recordBtn) {
    recordBtn = document.createElement("a");
    recordBtn.id = "recordBtn";
    recordBtn.className = "waves-effect waves-light btn-small orange";
    recordBtn.textContent = "\u23FA";
    recordBtn.title = "Record 60s (WebM)";
    const stopBtn = document.getElementById("stopPlay");
    if (stopBtn && stopBtn.parentNode) stopBtn.parentNode.insertBefore(recordBtn, stopBtn);
}
videoPauseBtn.onclick = () => setMediaPaused('video', !videoPaused);
audioPauseBtn.onclick = () => setMediaPaused('audio', !audioPaused);
// Client-side mute: toggles local playback volume only, independent of
// audioPauseBtn (which pauses the audio track server-side to save
// bandwidth). video starts with the `muted` attribute (autoplay policy),
// so sync the label to actual state rather than assuming unmuted.
function updateMuteBtnLabel() {
    muteBtn.innerText = video.muted ? '\u{1F507}' : '\u{1F50A}';
    muteBtn.title = video.muted ? 'Unmute' : 'Mute';
}
muteBtn.onclick = () => {
    video.muted = !video.muted;
    updateMuteBtnLabel();
};
video.addEventListener('volumechange', updateMuteBtnLabel);
updateMuteBtnLabel();
document.getElementById("fullscreenBtn").onclick = function() {
  var el = document.getElementById("video") || document.getElementById("player-container-id");
  if (el && el.requestFullscreen) { el.requestFullscreen(); }
  else if (el && el.webkitRequestFullscreen) { el.webkitRequestFullscreen(); }
};

// Snapshot/Record only make sense pinned to one explicit layer - in Auto
// (ABR) mode the resolution/bitrate can change mid-capture, so both actions
// are disabled until the user picks a layer manually. Recording in progress
// is force-stopped if the user switches back to Auto.
const RECORD_DURATION_MS = 60000;
let mediaRecorder = null;
let recordStopTimer = null;

function updateActionButtonsState() {
    const disabled = !abrEngine || abrEngine.isAutoMode;
    snapshotBtn.disabled = disabled;
    recordBtn.disabled = disabled;
    if (disabled && mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
}
updateActionButtonsState();

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

snapshotBtn.onclick = () => {
    if (snapshotBtn.disabled || !video.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `snapshot-${Date.now()}.png`);
    }, 'image/png');
};

function startRecording() {
    if (mediaRecorder || !video.srcObject) return;
    const captureStream = video.captureStream || video.mozCaptureStream;
    if (typeof captureStream !== 'function') {
        console.warn('[Record] captureStream not supported in this browser');
        return;
    }
    const stream = captureStream.call(video);
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || 'video/webm';
    const chunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
        recordBtn.classList.remove('recording');
        recordBtn.title = 'Record 60s (WebM)';
        if (recordStopTimer) {
            clearTimeout(recordStopTimer);
            recordStopTimer = null;
        }
        mediaRecorder = null;
        if (chunks.length) downloadBlob(new Blob(chunks, { type: 'video/webm' }), `record-${Date.now()}.webm`);
    };
    mediaRecorder.start();
    recordBtn.classList.add('recording');
    recordBtn.title = 'Stop Recording';
    recordStopTimer = setTimeout(() => {
        if (mediaRecorder) mediaRecorder.stop();
    }, RECORD_DURATION_MS);
}

recordBtn.onclick = () => {
    if (recordBtn.disabled) return;
    if (mediaRecorder) {
        mediaRecorder.stop();
    } else {
        startRecording();
    }
};

layerSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === "auto") {
        abrEngine.setAutoMode(true);
        if (videoPaused || abrEngine.currentTrackId === abrEngine.audioTrackId) {
            const lowestVideo = abrEngine.videoTrackIds[0];
            if (lowestVideo !== undefined) switchMediaTrack(lowestVideo, 'user_resume');
        }
        console.log(`[UI] Switched to AUTO mode`);
    } else {
        abrEngine.setAutoMode(false);
        const trackId = parseInt(val);
        if (!isNaN(trackId) && controlClient) {
            console.log(`[UI] Manual select track: ${trackId}`);
            // 通知引擎手动切换了，更新其内部状态
            abrEngine.notifyManualSwitch(trackId);
            switchMediaTrack(trackId, 'manual_user');
        }
    }
    updateActionButtonsState();
});

function updatePlaybackCodecStatus(codecType) {
    activePlaybackCodec = codecType;
    console.log(`[Main] Playback codec: ${codecType}`);
    // Prefer the label index.html declares inline in #controls; fall back
    // to a floating badge for any HTML shell that doesn't have it (see the
    // #wsStatus auto-creation above for the same pattern).
    let label = document.getElementById('playbackCodecLabel');
    if (!label) {
        label = document.createElement('span');
        label.id = 'playbackCodecLabel';
        label.style.cssText = 'position:fixed;top:10px;right:30px;padding:2px 8px;border-radius:4px;' +
            'font-size:12px;font-weight:bold;color:#fff;z-index:9999;';
        document.body.appendChild(label);
    }
    label.textContent = `Playback codec: ${codecType}`;
    label.style.color = '#fff';
    label.style.background = codecType === 'hevc' ? '#6f42c1' : '#007bff';
}

// Determines which codec to request, given the raw WHEP URL the user (or
// index.html's ?url= param) provided. A URL that already spells out a
// codecType segment is treated as an explicit override and used as-is
// (matching the design doc's example URLs in §2.2); otherwise this player
// detects HEVC support itself and inserts the segment - see
// insertCodecTypeSegment / codec-capability.js.
async function resolveWhepUrlAndCodec(rawUrl) {
    const explicitMatch = rawUrl.match(/\/(h264|hevc)\/whep(\?|$)/);
    if (explicitMatch) {
        return { url: rawUrl, codecType: explicitMatch[1] };
    }
    let codecType = 'h264';
    if (typeof window.selectPlaybackCodec === 'function') {
        try {
            codecType = await window.selectPlaybackCodec();
        } catch (e) {
            console.warn('[Main] Codec capability detection failed, defaulting to h264:', e && e.message);
        }
    } else {
        console.warn('[Main] codec-capability.js not loaded; defaulting to h264');
    }
    return { url: insertCodecTypeSegment(rawUrl, codecType), codecType };
}

// Builds and connects a single WHEP session for the given (url, codecType)
// pair. Returns nothing directly - success/failure surface through the
// reader's onConnected/onError callbacks, same as before this function
// existed; extracted from startStream() so the HEVC->H264 fallback (see
// startStream) can call it a second time against a different URL/codec
// without duplicating the whole reader setup.
function negotiateAndConnect(generation, url, codecType) {
    updatePlaybackCodecStatus(codecType);

    reader = new MediaMTXWebRTCReader({
        url: url,
        maxBitrate: 2500, // 初始带宽限制
        onTrack: (evt) => {
            if (generation !== readerGeneration) return;
            if (evt.track.kind === 'video' || evt.track.kind === 'audio') {
                if (video.srcObject !== evt.streams[0]) {
                    video.srcObject = evt.streams[0];
                }
            }
            if (evt.track.kind === 'video' && !seiReaderAttached && evt.receiver &&
                typeof window.attachSeiTimestampReader === 'function') {
                seiReaderAttached = window.attachSeiTimestampReader(evt.receiver, (ts) => {
                    reportP2PDelay(ts, 'sei');
                }, activePlaybackCodec);
                if (seiReaderAttached) console.log('[SEI] abs-timestamp reader attached');
            }
        },
        onError: (err) => {
            if (generation !== readerGeneration) return;
            console.error("Reader Error:", err);

            // One-shot HEVC->H264 fallback (design doc §4.4 "播放失败降级"):
            // only for a codec/SDP negotiation failure, not a plain network
            // error, and only before any media has ever flowed on this
            // session (an established HEVC session losing its connection
            // should reconnect as HEVC, not silently downgrade).
            const looksLikeCodecFailure = /sdp|codec|not acceptable|406/i.test(String(err));
            if (codecType === 'hevc' && !hevcFallbackUsed && looksLikeCodecFailure &&
                (!reader || !reader.pc || reader.pc.connectionState !== 'connected')) {
                hevcFallbackUsed = true;
                console.warn('[Main] HEVC negotiation failed, falling back to H264 once:', err);
                const fallbackUrl = stripCodecTypeSegment(url);
                negotiateAndConnect(generation, insertCodecTypeSegment(fallbackUrl, 'h264'), 'h264');
                return;
            }

            statsContainer.innerHTML = `<div style="color: red; text-align: center;">Error: ${err}</div>`;
            // Force audio-only on connection failure to save bandwidth
            if (abrEngine && abrEngine.audioTrackId && abrEngine.currentTrackId !== abrEngine.audioTrackId) {
                console.warn("[Main] Connection lost, forcing audio-only mode");
                if (controlClient) switchMediaTrack(abrEngine.audioTrackId, 'connection_lost');
                pauseVideoForAudioOnly();
            }
        },
        onConnected: () => {
            if (generation !== readerGeneration || !reader) return;
            const sessionId = reader.sessionId;
            console.log(`[Glue] WHEP Connected. SessionID: ${sessionId}`);
            if (window.parent) window.parent.postMessage('mmxplayer-connected', '*');
            if (sessionId) {
                initControlClient(url, sessionId);
            }
        }
    });
}

async function startStream() {
    stopStream();
    const generation = ++readerGeneration;

    const rawUrl = urlInput.value.trim();
    if (!rawUrl) return alert('Please enter a WHEP URL');

    // Publish (WHIP) and read (WHEP) URLs differ by one letter and are easy
    // to swap by mistake. Sending a WHIP URL here silently registers this
    // recvonly connection as a publish session: no error is returned, but
    // no media ever flows and the control WebSocket is rejected as "not a
    // reader session" a moment later. Fail loudly instead.
    const lastSegment = rawUrl.split('?')[0].split('/').filter(Boolean).pop();
    if (lastSegment === 'whip') {
        const fixedUrl = rawUrl.replace(/\/whip(\?|$)/, '/whep$1');
        alert(`This is a WHIP (publish) URL, not a WHEP (read) URL.\nUse:\n${fixedUrl}`);
        return;
    }

    statsContainer.innerHTML = '<div style="color: #00bcd4; text-align: center;">Connecting WHEP...</div>';
    previousTrackType = null;
    lastP2PDelayMs = null;
    lastP2PDelayAt = 0;
    lastP2PDelaySource = null;
    seiReaderAttached = false;
    negotiatedCodecs = { audio: null, video: null };
    hevcFallbackUsed = false;

    // Start calibrating against ppcenter in parallel with the WHEP handshake.
    // Failure is non-fatal: playback continues, P2P Delay just falls back to
    // the RTT/jitter-buffer estimate rather than showing an uncalibrated
    // (and therefore meaningless) subtraction.
    if (typeof window.TimeSync === 'function') {
        timeSync = new window.TimeSync({ ppcenter: ppcenterUrl() });
        timeSync.start().catch((e) => {
            console.warn('[TimeSync] calibration unavailable:', e && e.message);
        });
    } else {
        console.warn('[TimeSync] time-sync.js not loaded; P2P delay will use the RTT estimate');
    }

    const { url, codecType } = await resolveWhepUrlAndCodec(rawUrl);
    if (generation !== readerGeneration) return; // superseded while awaiting codec detection
    negotiateAndConnect(generation, url, codecType);

    lastStats.timestamp = Date.now();
    statsInterval = setInterval(updateStats, 1000);
}

function initControlClient(whepUrl, sessionId) {
    // Destroy previous client to stop stale reconnects
    if (controlClient) {
        controlClient.close();
        controlClient = null;
    }
    controlClient = new MMXControlClient(whepUrl, sessionId, {
		onMediaState: updateMediaState,
        onConnected: () => {
            wsStatusDot.classList.remove('ws-disconnected');
            wsStatusDot.classList.add('ws-connected');
            layerSelect.disabled = false;
            layerSelect.innerHTML = '<option value="-1">Loading...</option>';
        },
        onDisconnected: () => {
            wsStatusDot.classList.remove('ws-connected');
            wsStatusDot.classList.add('ws-disconnected');
            layerSelect.disabled = true;
        },
        onTracksInfo: (tracks, activeId) => {
            console.log("[UI] Received Tracks Info:", tracks);
            
            // [关键修复] 获取当前视频实际宽度，传给 ABR 引擎用于探测真实初始状态
            const currentVideoWidth = video.videoWidth || 0;
            abrEngine.setTracks(tracks, activeId, currentVideoWidth);
            if (videoPaused && abrEngine.audioTrackId !== null) {
                abrEngine.currentTrackId = abrEngine.audioTrackId;
            } else if (activeId !== undefined && activeId !== null) {
                lastVideoTrackId = activeId;
            }
            
            if (!layerSelect.disabled){
                updateLayerSelectUI(tracks, activeId);
            }
        },
        onObsTimestamp: (data) => {
            // Fallback path (see comment above lastP2PDelayMs) - only used
            // when SEI reading isn't available. Only count frames from the
            // layer we're actually decoding: OBS tags each simulcast
            // layer's frames with that layer's own rid, and
            // frame_no/timestamp are meaningless if mismatched.
            const activeTrack = abrEngine.trackRegistry[abrEngine.currentTrackId];
            const activeRid = activeTrack ? String(activeTrack.rid) : null;
            if (activeRid === null || String(data.rid) !== activeRid) return;
            reportP2PDelay(data.timestamp, 'datachannel');
        },
        onLayerSwitched: (id) => {
            console.log("[UI] Received Track switch:", id);

            const currentTrack = abrEngine.trackRegistry[id];
            const wasAudioOnly = previousTrackType === 'audio';
            const isNowVideo = currentTrack && currentTrack.type === 'video';
            
            if (wasAudioOnly && isNowVideo) {
                console.log('[Main] Resuming from audio-only to video - forcing video play');
                handleVideoResume();
                resumeVideoFromAudioOnly();
            }
            
            previousTrackType = currentTrack ? currentTrack.type : null;
            abrEngine.notifyLayerSwitched(id);
            
            // Pause video on audio-only to save bandwidth
            if (id === abrEngine.audioTrackId) {
                pauseVideoForAudioOnly();
            }
            
            if (!abrEngine.isAutoMode && !layerSelect.disabled) {
                layerSelect.value = id;
            }
        }
    });
}

// ✅ NEW: Handle video resume after audio-only mode
function handleVideoResume() {
    if (!video || !video.srcObject) {
        console.warn('[Main] Cannot resume video - no video element or stream');
        return;
    }
    
    // Strategy 1: Ensure video is not paused
    if (video.paused) {
        console.log('[Main] Video is paused, attempting to play...');
        video.play().catch(err => {
            console.warn('[Main] Auto-play failed:', err);
        });
    }
    
    // Strategy 2: Force a small seek to trigger rendering
    // This helps in cases where the video element is "stuck"
    setTimeout(() => {
        if (video.readyState >= 2) { // HAVE_CURRENT_DATA or better
            const currentTime = video.currentTime;
            if (currentTime > 0.01) {
                video.currentTime = currentTime - 0.01;
                console.log('[Main] Applied micro-seek to trigger video rendering');
            }
        }
    }, 100);
    
    // Strategy 3: Force video element refresh
    // Some browsers need this to properly resume video rendering
    setTimeout(() => {
        if (video.paused && video.srcObject) {
            console.log('[Main] Video still paused after 500ms, forcing play');
            video.play().catch(err => {
                console.warn('[Main] Delayed auto-play failed:', err);
            });
        }
    }, 500);
}

function pauseVideoForAudioOnly() {
    if (video && !video.paused) {
        console.log('[Main] Pausing video for audio-only mode');
        video.pause();
    }
}

function resumeVideoFromAudioOnly() {
    if (video && video.paused && video.srcObject) {
        console.log('[Main] Resuming video from audio-only mode');
        video.play().catch(err => console.warn('[Main] Video resume failed:', err));
    }
}

function updateLayerSelectUI(tracks, activeId) {
    layerSelect.innerHTML = '';
    
    const autoOption = document.createElement('option');
    autoOption.value = 'auto';
    autoOption.text = 'Auto (ABR)';
    layerSelect.appendChild(autoOption);

    const videos = tracks.filter(t => t.type === 'video');
    // UI显示：码率从高到低
    videos.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    videos.forEach(t => {
        const option = document.createElement('option');
        option.value = t.id;
        let label = t.label || `Video ${t.id}`;
        option.text = label;
        layerSelect.appendChild(option);
    });

    const audios = tracks.filter(t => t.type === 'audio');
    if (audios.length > 0) {
        const audioT = audios[0];
        const option = document.createElement('option');
        option.value = audioT.id;
        option.text = `Audio Opus`;
        option.style.fontWeight = 'bold';
        option.style.color = '#ff9800'; 
        layerSelect.appendChild(option);
    }

    // Restore the selection that was showing before the rebuild. mmx resends
    // TRACKS_INFO whenever track metadata changes - notably once it parses
    // each layer's real SPS and replaces the placeholder dimensions/labels
    // (SetTrackDimensions -> onTracksChanged in track_selector.go). That
    // arrives a second or two after playback starts, i.e. right after a user
    // has picked a quality, and rebuilding the <select> unconditionally reset
    // it to "Auto (ABR)": the manual choice appeared to be ignored even
    // though the layer switch itself had gone through.
    //
    // In manual mode the user's pick wins over whatever the server reports as
    // active (a switch may still be in flight). Only auto mode follows the
    // server.
    if (!abrEngine.isAutoMode) {
        // selectedTrackId() prefers a pending manual pick over the layer
        // that's currently playing, so a switch still in flight keeps showing
        // what the user asked for.
        const selected = abrEngine.selectedTrackId();
        const desired = (selected !== null && selected !== undefined) ? selected : activeId;
        // Fall back to auto only if that track no longer exists (e.g. the
        // publisher dropped a simulcast layer), otherwise the select would
        // silently show a value it doesn't have an option for.
        if (desired !== undefined && desired !== null &&
            tracks.some(t => String(t.id) === String(desired))) {
            layerSelect.value = desired;
        } else {
            layerSelect.value = 'auto';
        }
    } else {
        layerSelect.value = 'auto';
    }
}

function stopStream() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
    if (timeSync) {
        timeSync.stop();
        timeSync = null;
    }
    if (controlClient) {
        controlClient.close();
        controlClient = null;
    }
    if (reader) {
        reader.close();
        reader = null;
    }
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
    }
    video.srcObject = null;
    statsContainer.innerHTML = '<div style="color: #888; text-align: center;">Stopped</div>';
    
    wsStatusDot.classList.remove('ws-connected');
    wsStatusDot.classList.remove('ws-disconnected');
    layerSelect.disabled = true;
    layerSelect.innerHTML = '<option value="-1">Auto</option>';
    
    abrEngine.setAutoMode(true);
    previousTrackType = null;
    updateActionButtonsState();
}

async function updateStats() {
    if (!reader || !reader.pc) return;
    const pc = reader.pc;
    if (pc.connectionState !== 'connected' && pc.connectionState !== 'checking') return;

    try {
        // Cheap, and the transceivers can change (renegotiation, a track
        // arriving late), so refresh rather than reading once at connect.
        negotiatedCodecs = readNegotiatedCodecs(pc);

        const stats = await pc.getStats();
        const now = Date.now();
        const deltaTime = (now - lastStats.timestamp) / 1000;
        if (deltaTime <= 0) return;

        let videoStats = null;
        let audioStats = null;
        let networkStats = null;
        // [新增] 用于查找 codec 名称
        const codecs = new Map(); 

        stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') videoStats = report;
            if (report.type === 'inbound-rtp' && report.kind === 'audio') audioStats = report;
            if (report.type === 'candidate-pair' && report.state === 'succeeded') networkStats = report;
            // [新增] 收集 codec 信息
            // Only present once media has flowed on that track; see
            // negotiatedCodecs above for why that isn't enough on its own.
            if (report.type === 'codec') {
                codecs.set(report.id, report.mimeType); // e.g. "video/H264"
            }
        });

        // --- 计算实时指标 ---
        let videoKbps = 0;
        let audioKbps = 0;
        let fps = 0;
        let currentPacketLoss = 0;

        if (videoStats) {
            videoKbps = ((videoStats.bytesReceived - lastStats.videoBytes) * 8 / deltaTime / 1000);
            fps = videoStats.framesPerSecond || 0;
            const vLoss = (videoStats.packetsLost || 0) - (lastStats.videoPacketsLost || 0);
            if (vLoss > 0) currentPacketLoss += vLoss;
            lastStats.videoBytes = videoStats.bytesReceived;
            lastStats.videoPacketsLost = videoStats.packetsLost || 0;
        }

        if (audioStats) {
            audioKbps = ((audioStats.bytesReceived - lastStats.audioBytes) * 8 / deltaTime / 1000);
            const aLoss = (audioStats.packetsLost || 0) - (lastStats.audioPacketsLost || 0);
            if (aLoss > 0) currentPacketLoss += aLoss;
            lastStats.audioBytes = audioStats.bytesReceived;
            lastStats.audioPacketsLost = audioStats.packetsLost || 0;
        }

        lastStats.timestamp = now;

        // --- 调用 ABR 引擎 ---
        if (abrEngine) {
            abrEngine.update(videoKbps, audioKbps, fps, currentPacketLoss);
        }

        // RTT/jitter-buffer-based rough p2p delay estimate. Used both as
        // the LATENCY_REPORT payload's estimated_e2e_ms and, when the
        // SEI/DataChannel measurement looks clock-skewed (see
        // P2P_DELAY_CLOCK_SUSPECT_MS), as the displayed P2P Delay fallback.
        const rttMs = networkStats?.currentRoundTripTime ? networkStats.currentRoundTripTime * 1000 : 0;
        const jitterBufferMs = videoStats?.jitterBufferDelay && videoStats?.jitterBufferEmittedCount
            ? (videoStats.jitterBufferDelay / videoStats.jitterBufferEmittedCount) * 1000
            : 0;
        const estimatedP2PDelayMs = rttMs / 2 + jitterBufferMs + 10;

        // --- 渲染 UI ---
        let html = '';

        if (videoStats) {
            const displayW = video.videoWidth || videoStats.frameWidth || 0;
            const displayH = video.videoHeight || videoStats.frameHeight || 0;
            
            // [新增] 获取 Video Codec 名称
            // mimeType 格式通常是 "video/H264"，我们只取后半部分
            const vMime = videoStats.codecId && codecs.get(videoStats.codecId);
            const vCodec = (vMime && vMime.split('/')[1]) || negotiatedCodecs.video || 'N/A';

            html += renderStatGroup('Video', {
                'Codec': vCodec, // [显示]
                'Resolution': `${displayW}x${displayH}`,
                'Recv Bitrate': `${videoKbps.toFixed(0)} kbps`,
                'FPS': fps.toFixed(1),
                'Packet Loss': `${videoStats.packetsLost} pkts`
            });
        }

        if (audioStats) {
            // [新增] 获取 Audio Codec 名称
            const aMime = audioStats.codecId && codecs.get(audioStats.codecId);
            const aCodec = (aMime && aMime.split('/')[1]) || negotiatedCodecs.audio || 'N/A';

            html += renderStatGroup('Audio', {
                'Codec': aCodec, // [显示]
                'Recv Bitrate': `${audioKbps.toFixed(0)} kbps`,
                'Packet Loss': `${audioStats.packetsLost} pkts`,
                'Jitter': `${(audioStats.jitter * 1000).toFixed(1)} ms`
            });
        }

        if (networkStats) {
            let bw = 'N/A';
            if (networkStats.availableIncomingBitrate) {
                bw = `${(networkStats.availableIncomingBitrate / 1000).toFixed(0)} kbps`;
            }
            
            let abrStatus = (abrEngine && abrEngine.isAutoMode) ? 'Auto' : 'Manual';
            if (abrEngine && abrEngine.abrCooldown > 0) abrStatus += ` (Cool ${abrEngine.abrCooldown})`;

            const p2pFresh = lastP2PDelayMs !== null && (Date.now() - lastP2PDelayAt) < P2P_DELAY_STALE_MS;
            // A fresh measurement outside [SUSPECT, MAX_PLAUSIBLE] is a clock
            // artifact rather than a real delay (see the const comments
            // above) - fall back to the RTT/jitter-buffer estimate instead of
            // showing a misleadingly tiny, negative, or absurdly large number.
            const p2pImplausible = p2pFresh &&
                (lastP2PDelayMs < P2P_DELAY_CLOCK_SUSPECT_MS || lastP2PDelayMs > P2P_DELAY_MAX_PLAUSIBLE_MS);
            const p2pLabel = !p2pFresh
                ? (timeSync && !timeSync.isReady() ? 'syncing clock...' : 'N/A')
                : p2pImplausible
                    ? `~${estimatedP2PDelayMs.toFixed(0)} ms (est.)`
                    : `${lastP2PDelayMs.toFixed(0)} ms (${lastP2PDelaySource === 'sei' ? 'SEI' : 'DC'})`;

            const netRows = {
                'RTT': `${(networkStats.currentRoundTripTime * 1000).toFixed(1)} ms`,
                'Est. Bandwidth': bw,
                'ABR State': abrStatus,
                'P2P Delay': p2pLabel
            };
            // Surface the calibration itself: a large offset or RTT is the
            // first thing to look at when a delay reading looks wrong.
            if (timeSync && timeSync.isReady()) {
                netRows['Clock Offset'] = `${timeSync.offsetMs.toFixed(0)} ms (rtt ${timeSync.lastSyncRttMs.toFixed(0)})`;
            }
            html += renderStatGroup('Network', netRows);
        }

        if (html) statsContainer.innerHTML = html;

        // ── LATENCY_REPORT: send e2e metrics to server every second ──
        if (controlClient && controlClient.ws && controlClient.ws.readyState === WebSocket.OPEN) {
            const loss = currentPacketLoss;
            const fpsVal = videoStats?.framesPerSecond || 0;

            controlClient.sendLatencyReport({
                rtt_ms: rttMs,
                jitter_buffer_ms: jitterBufferMs,
                packets_lost: loss,
                fps: fpsVal,
                estimated_e2e_ms: estimatedP2PDelayMs
            });
        }

    } catch (e) {
        console.warn("Error updating stats:", e);
    }
}

function renderStatGroup(title, data) {
    let rows = '';
    for (const [key, value] of Object.entries(data)) {
        let valClass = '';
        if (key === 'Packet Loss' && parseInt(value) > 0) valClass = 'warn';
        if (key === 'Est. Bandwidth') valClass = 'good';
        rows += `<div class="stat-row"><span class="stat-key">${key}:</span><span class="stat-val ${valClass}">${value}</span></div>`;
    }
    return `<div class="stat-group"><div class="stat-title">${title}</div>${rows}</div>`;
}

let videoPaused = false;
let audioPaused = false;

function setMediaPaused(kind, paused) {
    if (!reader || !controlClient) return;
    controlClient.setMediaState({ [kind]: paused ? 'paused' : 'resumed' });
}

function updateMediaState(state) {
    videoPaused = state.video === 'paused';
    audioPaused = state.audio === 'paused';
    videoPauseBtn.innerText = videoPaused ? '▶' : '⏸';
    videoPauseBtn.title = videoPaused ? 'Resume Video' : 'Pause Video';
    audioPauseBtn.innerText = audioPaused ? '▶' : '⏸';
    audioPauseBtn.title = audioPaused ? 'Resume Audio' : 'Pause Audio';
    video.style.opacity = videoPaused ? '0.5' : '1';
    if (videoPaused && abrEngine.audioTrackId !== null) {
        if (abrEngine.videoTrackIds.includes(abrEngine.currentTrackId)) lastVideoTrackId = abrEngine.currentTrackId;
        abrEngine.currentTrackId = abrEngine.audioTrackId;
        if (!abrEngine.isAutoMode) layerSelect.value = abrEngine.audioTrackId;
    } else if (abrEngine.currentTrackId === abrEngine.audioTrackId && lastVideoTrackId !== null) {
        abrEngine.currentTrackId = lastVideoTrackId;
    }
    const audioOnly = abrEngine.currentTrackId === abrEngine.audioTrackId;
    layerSelect.disabled = videoPaused && !audioOnly;
}
