import PPPlayer from './sdk/pplayer-sdk.js?v=20261113-1';

const $ = (id) => document.getElementById(id);
const ui = {
    stream: $('appStreamInput'),
    status: $('appStatus'),
    ws: $('appWsStatus'),
    quality: $('appQualitySelect'),
    p2p: $('appP2P'),
    start: $('appStartBtn'),
    exit: $('appExitBtn'),
    pauseVideo: $('appPauseVideoBtn'),
    pauseAudio: $('appPauseAudioBtn'),
    mute: $('appMuteBtn'),
    snapshot: $('appSnapshotBtn'),
    record: $('appRecordBtn'),
    fullscreen: $('appFullscreenBtn'),
    stats: $('appStatsBtn'),
};

const params = new URLSearchParams(window.location.search);
const DEFAULT_PPCENTER = 'https://api.pp-cdn.org';
const queryPpcenter = (params.get('ppcenter') || '').trim() || DEFAULT_PPCENTER;
const queryP2P = !(params.get('p2p') === '0' || params.get('p2p') === 'false');
const queryCodec = (() => {
    const value = (params.get('codec') || '').trim().toLowerCase();
    return value === 'h264' || value === 'hevc' ? value : '';
})();

ui.p2p.checked = queryP2P;

let player = null;
let playing = false;
let playStartedAt = 0;
let videoPaused = false;
let audioPaused = false;
let muted = true;
let statsVisible = true;
let syncTimer = null;

function setStatus(text, isError = false) {
    ui.status.textContent = text || '';
    ui.status.style.color = isError ? '#ff8b8b' : '#9aa4b2';
    if (text) console.log(`[app] ${text}`);
}

function setWsStatus(connected) {
    ui.ws.classList.toggle('ws-connected', connected);
    ui.ws.classList.toggle('ws-disconnected', !connected);
}

function setControlsEnabled(enabled) {
    ui.start.disabled = enabled;
    ui.exit.disabled = !enabled;
    for (const button of [ui.pauseVideo, ui.pauseAudio, ui.mute, ui.snapshot, ui.record, ui.fullscreen, ui.stats]) {
        button.disabled = !enabled;
    }
    if (!enabled) ui.quality.disabled = true;
}

function updatePauseVideoLabel() {
    ui.pauseVideo.title = videoPaused ? 'Resume Video' : 'Pause Video';
    ui.pauseVideo.innerHTML = videoPaused ? '&#x25B6;' : '&#x23F8;';
}

function updatePauseAudioLabel() {
    ui.pauseAudio.title = audioPaused ? 'Resume Audio' : 'Pause Audio';
    ui.pauseAudio.innerHTML = audioPaused ? '&#x25B6;' : '&#x23F8;';
}

function updateMuteLabel() {
    ui.mute.title = muted ? 'Unmute' : 'Mute';
    ui.mute.innerHTML = muted ? '&#x1F507;' : '&#x1F50A;';
}

function updateRecordLabel(recording) {
    ui.record.classList.toggle('recording', !!recording);
    ui.record.title = recording ? 'Stop Recording' : 'Record 60s (WebM)';
}

function fillQuality(tracks, activeId, opts = {}) {
    const allowAuto = opts.auto !== false;
    const videos = tracks.filter((track) => track.type === 'video').slice()
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    ui.quality.innerHTML = '';
    if (allowAuto) {
        const autoOption = document.createElement('option');
        autoOption.value = 'auto';
        autoOption.textContent = 'Auto (ABR)';
        ui.quality.appendChild(autoOption);
    }
    for (const track of videos) {
        const option = document.createElement('option');
        option.value = String(track.id);
        option.textContent = track.label || `${track.width || '?'}x${track.height || '?'}`;
        ui.quality.appendChild(option);
    }
    ui.quality.disabled = videos.length === 0 || !playing;
    const desired = activeId !== undefined && activeId !== null ? String(activeId)
        : (allowAuto ? 'auto' : (videos.length ? String(videos[0].id) : ''));
    if ([...ui.quality.options].some((option) => option.value === desired)) {
        ui.quality.value = desired;
    }
}

function startSync() {
    stopSync();
    syncTimer = setInterval(syncUi, 1000);
    syncUi();
}

function stopSync() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
}

async function syncUi() {
    if (!player) return;
    try {
        const state = await player.get_state();
        if (!state.playing) {
            if (performance.now() - playStartedAt < 5000) return;
            playing = false;
            setWsStatus(false);
            setControlsEnabled(false);
            return;
        }
        playing = true;
        setWsStatus(true);
        setControlsEnabled(true);
        if (state.quality && ui.quality.value !== state.quality &&
            [...ui.quality.options].some((option) => option.value === state.quality)) {
            ui.quality.value = state.quality;
        }
        if (videoPaused !== state.videoPaused) {
            videoPaused = state.videoPaused;
            updatePauseVideoLabel();
        }
        if (audioPaused !== state.audioPaused) {
            audioPaused = state.audioPaused;
            updatePauseAudioLabel();
        }
        if (muted !== state.muted) {
            muted = state.muted;
            updateMuteLabel();
        }
        if (statsVisible !== state.statisticsVisible) {
            statsVisible = state.statisticsVisible;
        }
        if (typeof state.recording === 'boolean') {
            updateRecordLabel(state.recording);
        }
        if (ui.p2p.checked !== state.p2p) {
            ui.p2p.checked = state.p2p;
        }
        ui.quality.disabled = ui.quality.options.length <= 1;
    } catch (error) {
        console.warn('[app] state sync failed:', error);
    }
}

function streamNameFromStreamId(raw) {
    if (!raw || /^https?:\/\//i.test(raw)) return '';
    const parts = String(raw).trim().replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    return parts.length >= 2 ? parts[1] : '';
}

function streamNameFromWhepUrl(raw) {
    try {
        const segments = new URL(raw).pathname.split('/').filter(Boolean);
        if (segments[segments.length - 1] === 'whep') segments.pop();
        if (['h264', 'hevc', 'av1'].includes(segments[segments.length - 1])) segments.pop();
        return segments.pop() || '';
    } catch {
        return '';
    }
}

function streamNameFromOptions(options) {
    if (!options || typeof options !== 'object') return '';
    if (options.streamName) return String(options.streamName).trim();
    if (options.stream) return streamNameFromStreamId(options.stream);
    if (options.url) return streamNameFromWhepUrl(options.url);
    return '';
}

function viewportForStreamName(streamName) {
    const last = String(streamName || '').trim().slice(-1).toLowerCase();
    if (last === 'h') return { width: 1280, height: 720, fit: 'contain' };
    if (last === 'v') return { width: 720, height: 1280, fit: 'contain' };
    return { width: '100%', height: '100%', aspectRatio: null, fit: 'contain' };
}

async function applyStreamViewport(options) {
    const streamName = streamNameFromOptions(options);
    const viewport = viewportForStreamName(streamName);
    await player.set_viewport(viewport);
    return { streamName, viewport };
}

async function play(options) {
    playStartedAt = performance.now();
    setStatus('Starting...');
    setWsStatus(false);
    try {
        const { streamName, viewport } = await applyStreamViewport(options);
        console.log(`[app] stream=${streamName || '-'} viewport=${viewport.width}x${viewport.height}`);
        await player.play(options);
        playing = true;
        setControlsEnabled(true);
        setStatus('');
        startSync();
    } catch (error) {
        playing = false;
        setControlsEnabled(false);
        setWsStatus(false);
        setStatus(error.message, true);
        throw error;
    }
}

async function playFromInput() {
    const raw = ui.stream.value.trim();
    if (!raw) {
        setStatus('Enter a stream as appId/streamName (optionally append /h264 or /hevc)', true);
        return;
    }
    const options = /^https?:\/\//i.test(raw)
        ? { url: raw, p2p: ui.p2p.checked, ppcenter: queryPpcenter }
        : { stream: raw, p2p: ui.p2p.checked, ppcenter: queryPpcenter };
    try {
        await play(options);
    } catch {
        // play() already surfaced the error.
    }
}

function signedLinkOptions() {
    const required = ['ppcenter', 'appId', 'streamName', 'txTime', 'txSecret'];
    const values = {};
    for (const key of required) values[key] = (params.get(key) || '').trim();
    const missing = required.filter((key) => !values[key]);
    if (missing.length === required.length) return null;
    if (missing.length > 0) {
        throw new Error(
            'ppcenter, appId, streamName, txTime and txSecret must be provided together' +
            ` (missing: ${missing.join(', ')})`);
    }
    return {
        ppcenter: values.ppcenter || DEFAULT_PPCENTER,
        appId: values.appId,
        streamName: values.streamName,
        txTime: values.txTime,
        txSecret: values.txSecret,
        codec: queryCodec || undefined,
        p2p: ui.p2p.checked,
    };
}

function prefillStreamInput(appId, streamName, codec) {
    const value = [appId, streamName, codec].filter(Boolean).join('/');
    if (value) ui.stream.value = value;
}

async function autoStart() {
    const directUrl = (params.get('url') || '').trim();
    if (directUrl) {
        try {
            await play({ url: directUrl, p2p: ui.p2p.checked, ppcenter: queryPpcenter });
        } catch {
            // play() already surfaced the error.
        }
        return;
    }

    let options = null;
    try {
        options = signedLinkOptions();
    } catch (error) {
        setStatus(error.message, true);
        return;
    }
    if (options) {
        prefillStreamInput(options.appId, options.streamName, options.codec);
        try {
            await play(options);
        } catch {
            // play() already surfaced the error.
        }
        return;
    }

    if (params.get('autoplay') !== '0') await playFromInput();
}

async function exitPlayback() {
    stopSync();
    playing = false;
    playStartedAt = 0;
    try {
        await player.exit();
    } catch (error) {
        console.warn('[app] exit failed:', error);
    }
    setControlsEnabled(false);
    setWsStatus(false);
    setStatus('Stopped');
    ui.quality.innerHTML = '<option value="auto">Auto</option>';
    ui.quality.disabled = true;
    updateRecordLabel(false);
    updatePauseVideoLabel();
    updatePauseAudioLabel();
}

ui.start.addEventListener('click', playFromInput);

ui.exit.addEventListener('click', exitPlayback);

ui.p2p.addEventListener('change', () => {
    if (!playing) return;
    playStartedAt = performance.now();
    player.connect_p2p(ui.p2p.checked).catch((error) => {
        setStatus(error.message, true);
    });
});

ui.quality.addEventListener('change', () => {
    if (!playing) return;
    player.switch_quality(ui.quality.value).catch((error) => {
        setStatus(error.message, true);
    });
});

ui.pauseVideo.addEventListener('click', async () => {
    videoPaused = !videoPaused;
    try {
        await player.pause_video(videoPaused);
        updatePauseVideoLabel();
    } catch (error) {
        videoPaused = !videoPaused;
        setStatus(error.message, true);
    }
});

ui.pauseAudio.addEventListener('click', async () => {
    audioPaused = !audioPaused;
    try {
        await player.pause_audio(audioPaused);
        updatePauseAudioLabel();
    } catch (error) {
        audioPaused = !audioPaused;
        setStatus(error.message, true);
    }
});

ui.mute.addEventListener('click', async () => {
    muted = !muted;
    try {
        await (muted ? player.mute() : player.unmute());
        updateMuteLabel();
    } catch (error) {
        muted = !muted;
        setStatus(error.message, true);
    }
});

ui.snapshot.addEventListener('click', async () => {
    try {
        const blob = await player.snapshot();
        setStatus(blob ? `Snapshot saved (${Math.round(blob.size / 1024)} KB)` : 'Snapshot unavailable before the first frame', !blob);
    } catch (error) {
        setStatus(error.message, true);
    }
});

ui.record.addEventListener('click', async () => {
    try {
        const recording = await player.record();
        updateRecordLabel(recording);
        setStatus(recording ? 'Recording started' : 'Recording stopped');
    } catch (error) {
        setStatus(error.message, true);
    }
});

ui.fullscreen.addEventListener('click', () => {
    player.fullscreen().catch((error) => setStatus(error.message, true));
});

ui.stats.addEventListener('click', async () => {
    statsVisible = !statsVisible;
    try {
        await (statsVisible ? player.show_statistics() : player.hide_statistics());
    } catch (error) {
        statsVisible = !statsVisible;
        setStatus(error.message, true);
    }
});

ui.stream.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || ui.start.disabled) return;
    event.preventDefault();
    playFromInput();
});

try {
    player = await PPPlayer.create({
        container: '#player',
        onTracksInfo(tracks, activeId, meta) {
            fillQuality(tracks, activeId, meta || {});
            if (tracks.length) setWsStatus(true);
        },
        onFrameTimestamp() {
            setWsStatus(true);
        },
    });
    setControlsEnabled(false);
    updatePauseVideoLabel();
    updatePauseAudioLabel();
    updateMuteLabel();
    updateRecordLabel(false);
    await player.show_statistics();
    statsVisible = true;
    setStatus('');
    await autoStart();
} catch (error) {
    setControlsEnabled(false);
    setWsStatus(false);
    setStatus(`Player failed to start: ${error.message}`, true);
}
