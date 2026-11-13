const __modules = Object.create(null);

const __cache = Object.create(null);

function __require(id) {
  const cached = __cache[id];
  if (cached) return cached.exports;
  const factory = __modules[id];
  if (!factory) throw new Error('pplayer-sdk: unknown module ' + id);
  const module = { exports: {} };
  __cache[id] = module;
  factory(module, module.exports, __require);
  return module.exports;
}

__modules["/pplayer.js"] = function (module, exports, __require) {
const STYLE_ID = 'pplayer-sdk-style';
const ROOT_CLASS = 'pplayer-sdk-root';
const STATS_CLASS = 'pplayer-sdk-stats';

const SDK_STYLE = `
.pplayer-sdk-root{position:relative;width:100%;height:100%;background:#000;overflow:hidden;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif}
.pplayer-sdk-root.pplayer-sdk-aspect{height:auto;aspect-ratio:16/9}
.pplayer-sdk-root>video{display:block;width:100%;height:100%;object-fit:contain;background:#000}
.pplayer-sdk-controls{display:none!important}
.pplayer-sdk-stats{position:absolute;top:10px;right:10px;width:min(320px,calc(100% - 20px));max-height:calc(100% - 20px);background:rgba(0,0,0,.85);border:1px solid #444;padding:10px;border-radius:6px;overflow-y:auto;font-size:13px;font-family:monospace;color:#fff;box-shadow:0 4px 6px rgba(0,0,0,.3);z-index:2}
.pplayer-sdk-stats.collapsed{display:none!important}
.pplayer-sdk-stats .stat-group{margin-bottom:15px}
.pplayer-sdk-stats .stat-title{color:#00bcd4;font-weight:bold;border-bottom:1px dashed #555;margin-bottom:5px;padding-bottom:3px}
.pplayer-sdk-stats .stat-row{display:flex;justify-content:space-between;margin-bottom:3px}
.pplayer-sdk-stats .stat-key{color:#aaa}
.pplayer-sdk-stats .stat-val{color:#fff;font-weight:bold}
.pplayer-sdk-stats .stat-val.good{color:#28a745}
.pplayer-sdk-stats .stat-val.warn{color:#ffc107}
.pplayer-sdk-stats .stat-val.bad{color:#dc3545}
.pplayer-sdk-ws-status{display:none!important}
`;

let singleton = null;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = SDK_STYLE;
  document.head.appendChild(style);
}

function createElement(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value;
    else if (key === 'textContent') node.textContent = value;
    else if (key === 'style' && value && typeof value === 'object') Object.assign(node.style, value);
    else if (value !== undefined && value !== null && value !== false) {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function resolveContainer(target) {
  if (!target) return document.body;
  if (typeof target === 'string') {
    const found = document.querySelector(target);
    if (!found) throw new Error(`PPPlayer container not found: ${target}`);
    return found;
  }
  if (target instanceof Element) return target;
  throw new Error('PPPlayer container must be a selector or an Element');
}

function toCssSize(value) {
  if (value === null || value === undefined || value === '') return '';
  return typeof value === 'number' ? `${value}px` : String(value);
}

function applyViewport(root, video, options = {}) {
  if (!root || !video) return;
  const has = (key) => Object.prototype.hasOwnProperty.call(options, key);
  const hasHeight = has('height') &&
    options.height !== null && options.height !== undefined && options.height !== '';
  if (has('width')) root.style.width = toCssSize(options.width);
  if (has('height')) root.style.height = toCssSize(options.height);
  if (has('aspectRatio')) {
    const ratio = (options.aspectRatio === null || options.aspectRatio === undefined || options.aspectRatio === '')
      ? '' : String(options.aspectRatio);
    root.style.aspectRatio = ratio;
    if (!hasHeight) root.style.height = ratio ? 'auto' : '';
  }
  const fit = has('fit') ? options.fit : options.objectFit;
  if (fit !== undefined) video.style.objectFit = fit === null || fit === '' ? '' : String(fit);
}

function mountPlayer(container, options) {
  ensureStyle();

  const root = createElement('div', { className: ROOT_CLASS });

  const video = createElement('video', {
    id: 'player-container-id',
    autoplay: true,
    playsinline: true,
    muted: true,
  });
  if (options.controls !== false) video.setAttribute('controls', '');

  if (!options.height && !(container.clientHeight > 0)) {
    root.classList.add('pplayer-sdk-aspect');
  }
  applyViewport(root, video, options);
  if (options.viewport && typeof options.viewport === 'object') {
    applyViewport(root, video, options.viewport);
  }

  const stats = createElement('div', {
    id: 'stats',
    className: `${STATS_CLASS} collapsed`,
  });
  stats.appendChild(createElement('div', {
    textContent: 'Waiting for stream...',
    style: { color: '#888', textAlign: 'center' },
  }));

  const controls = createElement('div', { className: 'pplayer-sdk-controls' });
  const streamInput = createElement('input', { id: 'streamInput', type: 'text' });
  const p2pCheckbox = createElement('input', { id: 'p2pCheckbox', type: 'checkbox', checked: true });
  const layerSelect = createElement('select', { id: 'layerSelect' });
  const wsStatus = createElement('span', { id: 'wsStatus', className: 'pplayer-sdk-ws-status' });
  const buttonIds = [
    'startPlay', 'stopPlay', 'videoPauseBtn', 'audioPauseBtn',
    'muteBtn', 'snapshotBtn', 'recordBtn', 'fullscreenBtn', 'statsToggleBtn',
  ];
  const buttons = buttonIds.map((id) => createElement('button', { id, type: 'button', textContent: id }));

  controls.appendChild(streamInput);
  controls.appendChild(p2pCheckbox);
  controls.appendChild(layerSelect);
  controls.appendChild(wsStatus);
  buttons.forEach((button) => controls.appendChild(button));

  root.appendChild(video);
  root.appendChild(stats);
  root.appendChild(controls);
  container.appendChild(root);

  return { root, video, stats, controls };
}

class PPPlayer {
  static async create(options = {}) {
    const player = new PPPlayer(options);
    await player.ready;
    return player;
  }

  constructor(options = {}) {
    if (singleton && !singleton.destroyed) {
      throw new Error('PPPlayer supports one instance per page');
    }
    if (document.querySelector(`.${ROOT_CLASS}`)) {
      throw new Error('PPPlayer is already mounted on this page');
    }
    this.options = { ...options };
    this.container = resolveContainer(options.container);
    this.root = null;
    this.video = null;
    this.stats = null;
    this.api = null;
    this.destroyed = false;
    singleton = this;
    this.ready = this._init();
  }

  async _init() {
    if (typeof window === 'undefined') {
      throw new Error('PPPlayer requires a browser environment');
    }
    const mounted = mountPlayer(this.container, this.options);
    this.root = mounted.root;
    this.video = mounted.video;
    this.stats = mounted.stats;

    window.__PPPLAYER_SDK__ = true;
    window.pplayer = Object.assign(window.pplayer || {}, {
      config: {
        ...(window.pplayer?.config || {}),
        ...(this.options.natProbe !== undefined ? { natProbe: this.options.natProbe } : {}),
        ...(this.options.natProbeGraceMs !== undefined ? { natProbeGraceMs: this.options.natProbeGraceMs } : {}),
        ...(this.options.tokenCache !== undefined ? { tokenCache: this.options.tokenCache } : {}),
      },
    });
    __require("/main.js");
    this.api = window.pplayer;

    if (typeof this.options.onTracksInfo === 'function') {
      this.api.onTracksInfo = (tracks, activeId) => {
        try { this.options.onTracksInfo(tracks, activeId); } catch (error) {
          console.warn('[pplayer] onTracksInfo callback failed:', error);
        }
      };
    }
    if (typeof this.options.onFrameTimestamp === 'function') {
      this.api.onFrameTimestamp = this.options.onFrameTimestamp;
    }
    if (typeof this.options.onReady === 'function') {
      this.options.onReady(this);
    }
    return this;
  }

  _call(method, ...args) {
    return this.ready.then(() => {
      const fn = this.api && this.api[method];
      if (typeof fn !== 'function') {
        throw new Error(`PPPlayer API is not available: ${method}`);
      }
      return fn(...args);
    });
  }

  play(options) {
    return this._call('play', options);
  }

  switch_quality(target) {
    return this._call('switch_quality', target);
  }

  connect_p2p(enabled = true) {
    return this._call('connect_p2p', enabled);
  }

  exit() {
    return this._call('exit');
  }

  pause_video(paused = true) {
    return this._call('pause_video', paused);
  }

  resume_video() {
    return this.pause_video(false);
  }

  pause_audio(paused = true) {
    return this._call('pause_audio', paused);
  }

  resume_audio() {
    return this.pause_audio(false);
  }

  mute() {
    return this._call('mute');
  }

  unmute() {
    return this._call('unmute');
  }

  snapshot() {
    return this._call('snapshot');
  }

  record() {
    return this._call('record');
  }

  fullscreen() {
    return this._call('fullscreen');
  }

  show_statistics() {
    return this._call('show_statistics');
  }

  hide_statistics() {
    return this._call('hide_statistics');
  }

  get_tracks() {
    return this._call('get_tracks');
  }

  get_state() {
    return this._call('get_state');
  }

  set_viewport(options = {}) {
    return this.ready.then(() => {
      applyViewport(this.root, this.video, options);
      return this.get_viewport();
    });
  }

  get_viewport() {
    return this.ready.then(() => ({
      width: this.root.style.width || null,
      height: this.root.style.height || null,
      aspectRatio: this.root.style.aspectRatio || null,
      fit: this.video.style.objectFit || 'contain',
      clientWidth: this.root.clientWidth,
      clientHeight: this.root.clientHeight,
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
    }));
  }

  switchQuality(target) {
    return this.switch_quality(target);
  }

  connectP2P(enabled = true) {
    return this.connect_p2p(enabled);
  }

  setViewport(options = {}) {
    return this.set_viewport(options);
  }

  getViewport() {
    return this.get_viewport();
  }

  pauseVideo(paused = true) {
    return this.pause_video(paused);
  }

  resumeVideo() {
    return this.resume_video();
  }

  pauseAudio(paused = true) {
    return this.pause_audio(paused);
  }

  resumeAudio() {
    return this.resume_audio();
  }

  showStatistics() {
    return this.show_statistics();
  }

  hideStatistics() {
    return this.hide_statistics();
  }

  destroy() {
    if (this.destroyed) return Promise.resolve();
    this.destroyed = true;
    return this._call('exit').catch(() => {}).then(() => {
      if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
      if (singleton === this) singleton = null;
    });
  }
}

if (typeof window !== 'undefined') {
  window.PPPlayer = PPPlayer;
}



exports["default"] = PPPlayer;
exports["PPPlayer"] = PPPlayer;
};

__modules["/main.js"] = function (module, exports, __require) {
// main.js - Adapted for tx UI
// Supports both tx HTML (#player-container-id, #quality-select)
// and legacy mmx HTML (#video, #layerSelect)

const { MMXControlClient, MediaMTXWebRTCReader, ABR_REASON_AUTO_BANDWIDTH } = __require("/ppplayer.mjs");
const { ABREngine } = __require("/abr-engine.mjs");
const { attachSeiTimestampReader, attachPassthroughTransform } = __require("/sei-timestamp.mjs");
const { selectPlaybackCodec } = __require("/codec-capability.mjs");
const { TimeSync } = __require("/time-sync.mjs");
const { parsePlayRequest, requestPlayDecisionWithRetry } = __require("/play-request.mjs");
const { buildEdgeWhepUrl } = __require("/edge-url.mjs");
const { isWhepUrl, looksLikeUrl, WHEP_ONLY_MESSAGE } = __require("/whep-url.mjs");
const { createDirectP2PPlayback, createPlaybackRace, startPlaybackFromDecision } = __require("/play-decision-runner.mjs");
const { gatherNatProbe, submitNatProbe } = __require("/nat-probe.mjs");
const { isValidObsTimestampMessage, computeDelayMs } = __require("/obs-timestamp.mjs");
const { parseBufferMs, applyPlayoutBuffer, DEFAULT_BUFFER_MS } = __require("/buffer-config.mjs");
const { CatchUpController, DEFAULT_TARGET_MS } = __require("/catchup-controller.mjs");
const { StallWatchdog } = __require("/stall-watchdog.mjs");
const { LagTracker } = __require("/lag-tracker.mjs");

const video = document.getElementById('player-container-id') || document.getElementById('video');
const statsContainer = document.querySelector('#local-video .stat ul') || document.getElementById('stats');
const layerSelect = document.getElementById('quality-select') || document.getElementById('layerSelect');
const wsStatusDot = document.getElementById('wsStatus');
const streamInputEl = document.getElementById('streamInput');
(() => {
    if (!wsStatusDot) {
        const dot = document.createElement('span');
        dot.id = 'wsStatus';
        dot.style.cssText = 'position:fixed;top:10px;right:10px;width:12px;height:12px;border-radius:50%;z-index:9999';
        document.body.appendChild(dot);
    }
})();

// Verbose diagnostics (per-tick P2P stats, low-level transport state trails)
// are opt-in with ?debug so a normal viewer's console stays readable.
const PP_DEBUG = new URLSearchParams(window.location.search).has('debug');

// Defaults for the "opened with no parameters" case - the console homepage's
// "open demo" button links to the bare page (HomePage.tsx). Overridable with
// ?ppcenter=&appId=&streamName=, or by editing the Stream box (whose demo
// default value lives in index.html).
const DEFAULT_PPCENTER = 'https://api.pp-cdn.org';

// Manual stream entry (the Stream box in index.html). A user types
// "appId/streamName" and optionally a trailing codec ("/h264" or "/hevc"); a
// codec, when present, overrides the browser-capability auto-selection for the
// edge WHEP path (the P2P path is always H264). manualStream holds the parsed
// box for the active session; lastStartManual remembers whether the current
// session came from the box, so a watchdog restart replays the same source.
let manualStream = null;
let lastStartManual = false;

// Parses the Stream box into { appId, streamName, codec }. codec is '' when
// omitted. Returns null when it does not carry both an appId and a streamName.
function parseStreamInput(raw) {
    // The box takes appId/streamName only; a pasted URL is not a stream id.
    if (looksLikeUrl(raw)) return null;
    const parts = String(raw || '').trim().replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const appId = parts[0];
    const streamName = parts[1];
    if (!appId || !streamName) return null;
    const codec = parts.slice(2)
        .map((p) => p.toLowerCase())
        .find((p) => p === 'h264' || p === 'hevc') || '';
    return { appId, streamName, codec };
}

// Prefills the Stream box so a signed link / ?url= preview shows what is
// playing; the box then doubles as a "play a different stream" entry point.
// The bare page keeps the demo default baked into index.html.
function prefillStreamInput() {
    if (!streamInputEl) return;
    const params = new URLSearchParams(window.location.search);
    const urlParam = (params.get('url') || '').trim();
    if (urlParam) {
        const { appId, streamName } = parseWhepStreamInfo(urlParam);
        const codec = (urlParam.match(/\/(h264|hevc)\/whep(?:\?|$)/) || [])[1] || '';
        if (appId && streamName) streamInputEl.value = [appId, streamName, codec].filter(Boolean).join('/');
        return;
    }
    const appId = (params.get('appId') || '').trim();
    const streamName = (params.get('streamName') || '').trim();
    if (appId && streamName) {
        const codec = (params.get('codec') || '').trim().toLowerCase();
        streamInputEl.value = [appId, streamName, (codec === 'h264' || codec === 'hevc') ? codec : '']
            .filter(Boolean).join('/');
    }
}

const DEFAULT_NAT_PROBE_GRACE_MS = 800;
const P2P_UNAVAILABLE_TTL_MS = 30000;
const TOKEN_CACHE_MARGIN_MS = 30000;
const viewerTokenCache = new Map();
const p2pUnavailableUntil = new Map();
let natProbeGraceMs = DEFAULT_NAT_PROBE_GRACE_MS;
let startupStartedAt = 0;
const startupMarks = new Map();

function sdkConfig() {
    if (typeof window === 'undefined') return {};
    if (!window.pplayer) window.pplayer = {};
    if (!window.pplayer.config) window.pplayer.config = {};
    return window.pplayer.config;
}

function clampNatProbeGrace(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_NAT_PROBE_GRACE_MS;
    return Math.max(0, Math.min(5000, Math.round(n)));
}

(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const cfg = sdkConfig();
    if (params.get('natProbe') !== null) {
        cfg.natProbe = params.get('natProbe') !== '0' && params.get('natProbe') !== 'false';
    }
    if (params.get('natProbeGraceMs') !== null) {
        cfg.natProbeGraceMs = clampNatProbeGrace(params.get('natProbeGraceMs'));
    }
    if (params.get('tokenCache') !== null) {
        cfg.tokenCache = params.get('tokenCache') !== '0' && params.get('tokenCache') !== 'false';
    }
})();

function startupBegin() {
    startupStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    startupMarks.clear();
}

function startupMark(name, extra = '') {
    if (!startupStartedAt || startupMarks.has(name)) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = now - startupStartedAt;
    startupMarks.set(name, elapsed);
    console.log(`[Startup] ${name} +${Math.round(elapsed)}ms${extra ? ` ${extra}` : ''}`);
    if (name === 'first-frame') {
        const parts = [...startupMarks.entries()].map(([key, value]) => `${key}=${Math.round(value)}ms`);
        console.log(`[Startup] total ${Math.round(elapsed)}ms (${parts.join(', ')})`);
    }
}

function tokenCacheKey(ppcenter, appId, streamName) {
    return `${ppcenter}|${appId}|${streamName}`;
}

function clearViewerTokenCache(ppcenter, appId, streamName) {
    viewerTokenCache.delete(tokenCacheKey(ppcenter, appId, streamName));
}

function p2pCacheKey(appId, streamName) {
    return `${appId}/${streamName}`;
}

function isP2PKnownUnavailable(appId, streamName) {
    if (!appId || !streamName) return false;
    const key = p2pCacheKey(appId, streamName);
    const until = p2pUnavailableUntil.get(key);
    if (!until) return false;
    if (Date.now() < until) return true;
    p2pUnavailableUntil.delete(key);
    return false;
}

function clearP2PKnownUnavailable(appId, streamName) {
    if (!appId || !streamName) return;
    p2pUnavailableUntil.delete(p2pCacheKey(appId, streamName));
}

function noteP2PDecision(playConfig, decision) {
    if (!playConfig?.appId || !playConfig?.streamName || !decision) return;
    const availability = decision.p2pAvailability;
    if (decision.mode === 'p2p-connect' && decision.p2p) {
        clearP2PKnownUnavailable(playConfig.appId, playConfig.streamName);
        return;
    }
    if (availability?.publisherConnected === false ||
        decision.reason === 'missing_publisher_probe') {
        p2pUnavailableUntil.set(
            p2pCacheKey(playConfig.appId, playConfig.streamName),
            Date.now() + P2P_UNAVAILABLE_TTL_MS);
    }
}

function shouldAttemptP2P(appId, streamName, codec) {
    if (!preferP2P() || codec === 'hevc') return false;
    if (sdkConfig().natProbe === false) return false;
    if (isP2PKnownUnavailable(appId, streamName)) return false;
    return true;
}

// Mints a short-lived viewer token from appId+streamName via ppcenter's open
// POST /v1/play/link (no appSecret in the browser), so a bare/`?appId=` page
// can go through the normal ppcenter -> P2P/edge flow.
async function mintViewerToken(ppcenter, appId, streamName) {
    const cacheEnabled = sdkConfig().tokenCache !== false;
    const key = tokenCacheKey(ppcenter, appId, streamName);
    if (cacheEnabled) {
        const cached = viewerTokenCache.get(key);
        if (cached && cached.expiresAtMs > Date.now() + TOKEN_CACHE_MARGIN_MS) {
            return {
                txTime: cached.txTime,
                txSecret: cached.txSecret,
                expiresAt: cached.expiresAt,
                cached: true,
            };
        }
        if (cached) viewerTokenCache.delete(key);
    }

    const resp = await fetch(new URL('/v1/play/link', ppcenter).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, streamName }),
    });
    let body = null;
    try { body = await resp.json(); } catch { /* handled below */ }
    if (!resp.ok || !body?.txTime || !body?.txSecret) {
        throw new Error(body?.message || `token request failed (status ${resp.status})`);
    }

    const expiresAt = body.expiresAt || '';
    if (cacheEnabled) {
        let expiresAtMs = Date.parse(expiresAt);
        if (!Number.isFinite(expiresAtMs)) expiresAtMs = Date.now() + 5 * 60 * 1000;
        if (expiresAtMs > Date.now() + TOKEN_CACHE_MARGIN_MS) {
            viewerTokenCache.set(key, {
                txTime: body.txTime,
                txSecret: body.txSecret,
                expiresAt,
                expiresAtMs,
            });
        }
    }
    return { txTime: body.txTime, txSecret: body.txSecret, expiresAt, cached: false };
}

function newClientId() {
    return globalThis.crypto?.randomUUID ? crypto.randomUUID() : `pplayer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Live-edge catch-up is switched OFF for now (CATCHUP_ENABLED below): it has
// no working actuator - playbackRate is ignored for a MediaStream-backed
// element, and lowering the jitter-buffer target can only drain a few tens of
// ms and is a no-op once the buffer already sits at its minimum. Flip the
// flag to bring the buffer-based version back.
//
// Live-edge catch-up (see catchup-controller.mjs): drains delay that has
// already built up, rather than just limiting how fast new delay accrues.
// "catchupTargetMs" lets a deployment tune this the same way "bufferMs"
// tunes the playout buffer.
//
// It only has anything to actuate when a playout buffer was explicitly pinned:
// draining then means temporarily lowering that pinned target so the jitter
// buffer plays out ahead. With the default (no bufferMs), the browser's own
// adaptive jitter buffer already shrinks back down on its own, so the
// controller is deliberately left without an actuator and reports itself
// unavailable instead of pretending. The previous playbackRate actuator never
// worked at all - the rate is ignored for a MediaStream-backed element.
const catchupTargetMs = (() => {
    const raw = new URLSearchParams(window.location.search).get('catchupTargetMs');
    const parsed = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TARGET_MS;
})();

// How far below the pinned buffer to drop while catching up. Small enough that
// draining stays gradual rather than forcing an audible skip, and clamped by
// applyPlayoutBuffer to MIN_BUFFER_MS anyway.
const CATCHUP_BUFFER_DRAIN_MS = 50;

function applyCatchUpBuffer(engaged) {
    // No pinned buffer means the browser's adaptive one is in charge and
    // already drains excess delay - there is nothing here to lower. Returning
    // false keeps the controller (and the on-screen label) honest about that.
    if (bufferMs === null) return false;
    const pc = activePlaybackPath?.pc || reader?.pc;
    if (!pc) return false;
    return applyPlayoutBuffer(pc, engaged ? bufferMs - CATCHUP_BUFFER_DRAIN_MS : bufferMs) !== null;
}

const CATCHUP_ENABLED = false;

const catchUpController = new CatchUpController(video, {
    targetMs: catchupTargetMs,
    onCatchUp: applyCatchUpBuffer,
});
catchUpController.setEnabled(CATCHUP_ENABLED);

// Auto-recovers the "receiving bytes but decoding nothing" stall (see
// stall-watchdog.mjs) by doing exactly what a manual Start click does -
// tear down and renegotiate the whole session. Observed cause: an OBS
// stop/restart during which Origin's forward-to-Edge WHIP session survives
// in a stuck state (see the 2026-09-16 incident notes), which no amount of
// front-end buffering/catch-up tuning fixes since no decodable frame is
// ever arriving in the first place.
const stallWatchdog = new StallWatchdog({
    onStall: () => {
        console.warn('[Watchdog] Video stalled (receiving data, 0 fps) - restarting stream');
        showToast('Stream stalled, reconnecting...');
        startStream(lastStartManual);
    }
});

// Rebuffering (卡顿) accounting for the pull stats. A pause longer than the
// threshold counts as one lag event; the totals ride along on the viewer
// session (start/heartbeat/stop) so ppcenter can derive a rebuffering rate.
const lagTracker = new LagTracker();

// Playout buffer length: how much media the jitter buffer holds before
// rendering, trading latency against resilience to jitter. Purely local -
// nothing is negotiated with the server, and there is no UI control for it.
// Defaults to DEFAULT_BUFFER_MS (50ms); a "bufferMs" query parameter can still
// override it for testing.
let bufferMs = parseBufferMs(new URLSearchParams(window.location.search).get('bufferMs')) ?? DEFAULT_BUFFER_MS;

// Normally P2P is opt-out for signed links: checked, playback asks ppcenter
// for a direct connection and races it against the edge leg, falling back to
// the edge node when NAT traversal fails or the decision is edge-only.
// Unchecked forces edge-only. ?p2p=0 / ?p2p=false unchecks it (edge-only share
// link); on a page with no ppcenter params the checkbox has no effect.
//
// P2P connection is temporarily disabled in pplayer while the standalone
// p2player harness (D:\gitlab\ppcdn\p2player) brings up and verifies P2P
// playback. All P2P code below and in playback-paths.mjs /
// playback-race-controller.mjs / nat-probe.mjs is retained; flip this to true
// to re-enable once P2P playback is proven end-to-end.
const P2P_CONNECTION_ENABLED = true;

const p2pCheckbox = document.getElementById('p2pCheckbox');
(() => {
    if (p2pCheckbox && !P2P_CONNECTION_ENABLED) {
        p2pCheckbox.checked = false;
        p2pCheckbox.disabled = true;
        p2pCheckbox.title = 'P2P is temporarily disabled (testing in p2player).';
    }
    const raw = new URLSearchParams(window.location.search).get('p2p');
    if (p2pCheckbox && raw !== null) {
        p2pCheckbox.checked = !(raw === '0' || raw === 'false');
    }
})();

function preferP2P() {
    return P2P_CONNECTION_ENABLED && (p2pCheckbox ? p2pCheckbox.checked : true);
}

// Toggling the switch mid-session re-requests the play decision so the change
// takes effect right away, instead of only on the next Start. Idle toggles do
// nothing (the decision is only asked for when a start begins).
if (p2pCheckbox) {
    p2pCheckbox.addEventListener('change', () => {
        if (reader || playbackRace) {
            startStream(lastStartManual);
        }
    });
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

// True only for a WHEP URL this page assembled itself from ppcenter's bare edge
// stream base (startDirectStream). A caller-supplied full URL (?url=) is signed
// over its exact codec path and must never be rewritten.
let codecPathFallback = false;

// Next WHEP URL to try after `whepUrl` returned 404, or null when exhausted:
// hevc -> h264 -> bare (no codec segment, where a multitrack-off publisher lives).
// The edge verifies the signature with the codec segment stripped, so all three
// share one query string. A typed ".../hevc" is an explicit request and never
// silently downgraded to H264.
function nextCodecPathCandidate(whepUrl) {
    const u = new URL(whepUrl);
    const parts = u.pathname.split('/');
    const whepIndex = parts.lastIndexOf('whep');
    const codec = whepIndex >= 2 ? parts[whepIndex - 1] : '';
    if (codec === 'hevc' && !(manualStream && manualStream.codec === 'hevc')) {
        parts[whepIndex - 1] = 'h264';
        u.pathname = parts.join('/');
        return { url: u.toString(), codecType: 'h264' };
    }
    if (codec === 'h264') {
        parts.splice(whepIndex - 1, 1);
        u.pathname = parts.join('/');
        return { url: u.toString(), codecType: 'h264' };
    }
    return null;
}

let reader = null;
let readerGeneration = 0;
// Guards the one-shot "edge rejected the WHEP token, refresh the play
// decision" recovery (see handleEdgeAuthRejected), so a persistent 401 can't
// loop. Reset for each new playback generation in startStream.
let edgeAuthRefreshed = false;
// The RTCRtpReceiver the Edge SEI reader is currently attached to, not a
// boolean. MediaMTXWebRTCReader reconnects a failed WHEP session internally
// (new PeerConnection, new receiver) without going through startStream, so a
// plain "already attached" flag would stay true across that retry and the new
// receiver - whose PeerConnection also sets encodedInsertableStreams - would
// never get a consumer. Every encoded frame would then be held at the transform
// insertion point forever (received/assembled, framesDecoded 0, black/2x2
// video) exactly when a first WHEP attempt fails and the retry succeeds.
let seiReaderReceiver = null;
let p2pSeiReaderAttached = false;
// Fast, SEI-specific stall detector for the exact symptom in startP2PPlayback's
// p2pSeiEnabled comment: encodedInsertableStreams can hold every encoded frame
// at the transform forever (received/assembled, framesDecoded stuck at 0)
// instead of a parse error or a clean failure. The generic StallWatchdog can't
// catch this - it only arms after firstFrameDecoded (see updateStats), which
// never becomes true here. p2pSeiZeroDecodeStreak counts consecutive
// updateStats() ticks (1/sec) where packets are arriving but framesDecoded is
// still 0; p2pSeiWatchdogTrip is the current P2P attempt's fallbackToEdge,
// reachable from updateStats() (a module-level function, not a closure over
// startP2PPlayback) only via this reference. One-shot: cleared the moment it
// fires, so a session that reaches this never retries SEI again (the P2P leg
// itself is untouched - this only abandons the transform in favor of edge,
// via the same fallback every other P2P failure already uses).
let p2pSeiZeroDecodeStreak = 0;
let p2pSeiWatchdogTrip = null;
const P2P_SEI_STALL_SECONDS = 3;
let controlClient = null;
let statsInterval = null;
// Set once a playback path is actually carrying media. In direct mode this
// is the reader; in raced mode it's whichever leg won. All three expose
// .pc, so one accessor covers every mode.
let activePlaybackPath = null;
let activePlaybackPathName = 'edge'; // 'edge' | 'p2p', for latency reporting
// Name of the edge node currently serving this pull; empty for P2P.
let activeEdgeNodeName = '';
let playbackRace = null;
let playRequestAbortController = null;
let lastStats = { videoBytes: 0, audioBytes: 0, timestamp: 0 };
let sdkLastPlayOptions = null;
let pendingQualityTarget = null;

// Loss has to be read as a RATE, not as a packet count. Audio runs at ~50
// packets/s and video at several hundred, so the two cumulative counters the
// stats panel used to print are an order of magnitude apart before a single
// packet is lost - which is how "audio loses far more than video" got read off
// a panel that was really showing "audio and video have different packet
// rates". These accumulate the per-tick deltas over the session for the
// per-kind loss RATE reported to ppcenter on LATENCY_REPORT (audio_loss_pct/
// video_loss_pct). The panel itself no longer prints either the raw counts or
// the rate: neither survives being read as "audio is worse", so the row is
// deliberately gone from the Video/Audio groups.
let lossTotals = { videoLost: 0, videoRecv: 0, audioLost: 0, audioRecv: 0 };

function resetLossTotals() {
    lossTotals = { videoLost: 0, videoRecv: 0, audioLost: 0, audioRecv: 0 };
}

// null when nothing has been expected yet (no packet of that kind has arrived),
// which the caller must show as "no reading" rather than as 0%.
function lossRatePct(lost, received) {
    const expected = lost + received;
    if (expected <= 0) return null;
    return (lost / expected) * 100;
}
let previousTrackType = null; // Track if we were in audio-only mode
let firstFrameDecoded = false; // Set when fps>0 is first seen; only then does the stall watchdog start monitoring
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
// 2. Server relay (OBS_TIMESTAMP over the ABR control WebSocket, see
//    obs_timestamp_broadcast.go in mmx): mmx extracts the same in-band SEI
//    from the publisher's bitstream - RTMP/SRT/WHIP ingest alike - and
//    rebroadcasts it, so this only needs a direct OBS->mmx->player hop
//    (no cascading). Kept as a fallback for non-Chromium browsers where
//    SEI reading isn't available.
//
// SEI takes priority whenever both are reporting fresh values.
let lastP2PDelayMs = null;
let lastP2PDelayAt = 0;
let lastP2PDelaySource = null; // 'sei' | 'relay'
const P2P_DELAY_STALE_MS = 5000;

// Public page API: the last per-frame publisher timestamp seen on either the
// in-band SEI path or the OBS_TIMESTAMP relay. This is the UTC ms stamped by
// ppobs when the frame was encoded, not the local time at which the browser
// paints it; callers that need paint time should combine it with
// requestVideoFrameCallback. Null once the stream has been silent for
// P2P_DELAY_STALE_MS so a paused/reconnected player never reports a stale frame.
let lastFrameTimestampInfo = null;

function getCurrentFrameTimestamp() {
    if (!lastFrameTimestampInfo) return null;
    const ageMs = Date.now() - lastFrameTimestampInfo.receivedAtMs;
    if (ageMs < 0 || ageMs > P2P_DELAY_STALE_MS) return null;
    return { ...lastFrameTimestampInfo, ageMs };
}

function noteFrameTimestamp(timestampMs, source) {
    const value = Number(timestampMs);
    if (!Number.isFinite(value) || value <= 0) return null;
    const info = {
        timestampMs: value,
        source,
        path: activePlaybackPathName,
        receivedAtMs: Date.now(),
    };
    lastFrameTimestampInfo = info;
    const callback = typeof window !== 'undefined' && window.pplayer
        ? window.pplayer.onFrameTimestamp
        : null;
    if (typeof callback === 'function') {
        try {
            callback({ ...info, ageMs: 0 });
        } catch (e) {
            console.warn('[pplayer] onFrameTimestamp callback failed:', e);
        }
    }
    return info;
}

if (typeof window !== 'undefined') {
    window.pplayer = Object.assign(window.pplayer || {}, {
        getCurrentFrameTimestamp,
    });
}
// Fixed compensation added to every delay reading, on BOTH the P2P and the
// Edge path (they share reportP2PDelay below, so there is no per-path
// branch). The in-band OBS SEI timestamp is stamped after encoding and read
// when the encoded frame reaches the receiver, so the raw subtraction stops
// short of the true end-to-end delay: it misses the encode time already spent
// before the stamp, and the decoder + compositor/render time after reception.
// +50ms stands in for that overhead. The configured playout buffer is added
// separately in reportP2PDelay: the SEI is read before the receiver's jitter
// buffer releases the frame, so without it the number would omit the largest
// local contribution on an edge pull. One shared computation keeps the two
// paths directly comparable.
const P2P_DELAY_FIXED_COMPENSATION_MS = 50;
// Both ends of the subtraction must share a clock base: the timestamp comes
// from ppobs's NTP-disciplined clock, so the local side has to be corrected
// by the ppcenter offset (see time-sync.js) before subtracting. Until that
// first calibration lands we don't compute a delay at all rather than
// publishing a number built on an unknown clock skew.
let timeSync = null;
// Even with calibration, a badly wrong clock (or a stale offset after
// ppcenter has been unreachable for a while) can still produce impossible
// values. A negative reading is always a clock artifact (media cannot arrive
// before it was sent), and anything near 60s is not a delay either since no
// WebRTC jitter buffer holds minutes of media. Only values outside this band
// fall back to the RTT/jitter-buffer estimate. The floor is deliberately 0,
// not ~100ms: a direct P2P hop (same LAN/datacenter, small jitter buffer) can
// legitimately measure well under 100ms, and the old ~100ms floor silently
// discarded those real readings and replaced them with an estimate. The upper
// bound matters: without it, positive skew (e.g. the ~145s seen when ppobs
// anchored its timestamps to a drifting monotonic clock) got printed verbatim
// while negative skew was correctly caught.
const P2P_DELAY_MIN_PLAUSIBLE_MS = 0;
const P2P_DELAY_MAX_PLAUSIBLE_MS = 60000;

function reportP2PDelay(timestampMs, source) {
    // SEI is strictly more accurate (in-band, cascade-safe, no rid
    // ambiguity) - once it's reporting, ignore stale server-relay values.
    if (source === 'relay' && lastP2PDelaySource === 'sei' &&
        (Date.now() - lastP2PDelayAt) < P2P_DELAY_STALE_MS) {
        return;
    }
    // Expose the raw timestamp even before TimeSync has calibrated: reading
    // it does not require a local clock, only computing the delay does.
    if (noteFrameTimestamp(timestampMs, source) === null) return;
    // No calibrated clock yet => no delay. Deliberately not falling back to
    // a raw Date.now(): that's what produced the bogus readings this whole
    // mechanism exists to fix.
    const correctedNow = timeSync ? timeSync.now() : null;
    if (correctedNow === null) return;

    // The SEI is read from the encoded frame as it arrives, before the
    // receiver's playout buffer releases it and before decode/render. Add the
    // configured buffer so the reported delay reflects what the viewer
    // experiences rather than transport-only time.
    const playoutBufferMs = Number.isFinite(bufferMs) ? bufferMs : 0;
    lastP2PDelayMs = correctedNow - Number(timestampMs) + P2P_DELAY_FIXED_COMPENSATION_MS + playoutBufferMs;
    lastP2PDelayAt = Date.now();
    lastP2PDelaySource = source;

    // Only report plausible values upstream; see the bounds above. The path
    // dimension lets ppcenter compare Edge against P2P (PLY-011).
    if (timeSync && lastP2PDelayMs >= P2P_DELAY_MIN_PLAUSIBLE_MS &&
        lastP2PDelayMs <= P2P_DELAY_MAX_PLAUSIBLE_MS) {
        timeSync.reportLatency({ path: activePlaybackPathName, delayMs: lastP2PDelayMs });
    }
}

// freshPlausibleP2PDelayMs returns the last SEI/relay measurement only while
// it is fresh and inside the same plausibility band used by the UI. Heartbeat
// reports must use this gate too: reportP2PDelay intentionally keeps an
// implausible value around for the UI's "estimate instead" fallback, but
// sending that value upstream poisons the per-stream/server aggregate after
// reconnect/clock-skew events (e.g. the observed 65510 ms sample).
function freshPlausibleP2PDelayMs() {
    if (!Number.isFinite(lastP2PDelayMs)) return null;
    if ((Date.now() - lastP2PDelayAt) >= P2P_DELAY_STALE_MS) return null;
    if (lastP2PDelayMs < P2P_DELAY_MIN_PLAUSIBLE_MS ||
        lastP2PDelayMs > P2P_DELAY_MAX_PLAUSIBLE_MS) return null;
    return lastP2PDelayMs;
}

// One-shot report of which path actually played, so ppcenter can count the
// true P2P penetration rate (P2P plays / total plays). Fired once per play:
// 'edge' immediately for an edge-only decision, or - for a p2p-connect
// decision - only once the controller settles ('p2p' if it committed to P2P,
// 'edge' if it gave up or reverted), because a p2p-connect offer does NOT mean
// P2P carried the media (a symmetric-NAT viewer falls back to edge). Reset per
// play in startFromPpcenter. Best-effort and keepalive so a tab closing right
// after it settles still delivers the beacon.
let playOutcomeReported = false;
// Set from the play decision so the outcome row carries the network condition
// (eligibility verdict + observed NAT types), not just the settled path.
let playOutcomeCondition = null;
// Pull-stream reporting state: playStartedAt is set when the play request goes
// out, firstFrameAt when the first video frame is decoded, so costTime is the
// ms from requesting the connection to receiving video data.
let playStartedAt = null;
let firstFrameAt = null;
// One requestVideoFrameCallback registration per play. The edge path used to
// learn about the first frame only from updateStats' 1Hz fps sample, which could
// report a load time up to ~1s later than the actual first presented frame.
let firstFrameCallbackArmed = false;
let activePlayConfig = null;
let playReportIpv4 = '';

function currentQualityLevel() {
    const h = (typeof video !== 'undefined' && video && video.videoHeight) || 0;
    return h > 0 ? `${h}p` : '';
}

// One connection report per play attempt (success or failure), sent to
// POST /v1/play/outcome. connType is p2p|edge, costTime is ms to first video,
// isOK says whether it connected, and reason carries the failure reason when
// isOK is false (or the eligibility verdict on success).
function reportPlayOutcome(playConfig, path, { isOK = true, reason = '' } = {}) {
    if (playOutcomeReported || !playConfig) return;
    playOutcomeReported = true;
    const headers = { 'Content-Type': 'application/json' };
    if (playConfig.txTime && playConfig.txSecret && playConfig.appId) {
        headers['Authorization'] = `Bearer ${playConfig.appId}:${playConfig.txTime}:${playConfig.txSecret}`;
    }
    const costTime = (isOK && firstFrameAt && playStartedAt) ? Math.max(0, firstFrameAt - playStartedAt) : 0;
    const body = {
        appId: playConfig.appId,
        streamName: playConfig.streamName,
        connType: path,
        path, // legacy name for the same value
        isOK,
        costTime,
        ipv4: playReportIpv4 || undefined,
        qualityLevel: isOK ? currentQualityLevel() : '',
        reason: (isOK ? playOutcomeCondition?.reason : reason) || undefined,
        publisherNat: playOutcomeCondition?.publisherNat,
        playerNat: playOutcomeCondition?.playerNat,
    };
    try {
        fetch(new URL('/v1/play/outcome', playConfig.ppcenter).toString(), {
            method: 'POST',
            headers,
            keepalive: true,
            body: JSON.stringify(body),
        }).catch(() => {});
    } catch {
        // Malformed ppcenter URL etc. - reporting is best-effort.
    }
    // A successful outcome means playback started: open the viewer session so
    // the console can list it as online (see startPlaySession). Pass the same
    // video-load time the outcome reports.
    if (isOK) startPlaySession(playConfig, path, costTime);
}

// Marks firstFrameAt at the first frame the browser actually presents, instead
// of waiting for updateStats' 1Hz fps sample (which could overstate the load
// time by up to a second). Used by the edge path; the P2P path already does
// this from its own onNegotiated callback. Safe to call for every video track:
// only the first call arms a callback, and reportPlayOutcome is once-guarded.
function armFirstVideoFrameCallback(generation) {
    if (firstFrameCallbackArmed) return;
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    firstFrameCallbackArmed = true;
    video.requestVideoFrameCallback(() => {
        if (generation !== readerGeneration) return;
        if (firstFrameAt === null) {
            firstFrameAt = Date.now();
            startupMark('first-frame');
            reportPlayOutcome(activePlayConfig, activePlaybackPathName || 'edge');
        }
    });
}

// ── Viewer session tracking (console "online pull" list) ──────────────────
// A session opens once playback actually starts (same moment the success
// outcome is reported), is kept alive by a ~20s heartbeat, and closes on
// teardown or page unload. ppcenter lists sessions whose last heartbeat is
// still fresh, so a viewer that vanishes without a stop report ages out.
let playSessionId = null;
let playSessionHeartbeatTimer = null;
// When the current session opened (ms). P2P delay is only reported once
// playback has settled (see startPlaySession's heartbeat).
let playSessionStartedAt = 0;

function playSessionAuthFields(playConfig) {
    return {
        appId: playConfig.appId,
        streamName: playConfig.streamName,
        txTime: playConfig.txTime,
        txSecret: playConfig.txSecret,
    };
}

function postPlaySession(path, body, { beacon = false } = {}) {
    if (!activePlayConfig) return;
    const url = new URL(path, activePlayConfig.ppcenter).toString();
    const payload = JSON.stringify(body);
    if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        // text/plain is CORS-safelisted, so the unload beacon is not
        // preflighted; ppcenter parses the body as JSON regardless of type.
        navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain' }));
        return;
    }
    try {
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: payload,
        }).catch(() => {});
    } catch { /* best-effort */ }
}

function startPlaySession(playConfig, path, costTimeMs = 0) {
    if (!playConfig || playSessionId) return;
    playSessionId = globalThis.crypto?.randomUUID
        ? crypto.randomUUID()
        : `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    postPlaySession('/v1/play/session/start', {
        sessionId: playSessionId,
        ...playSessionAuthFields(playConfig),
        path,
        ipv4: playReportIpv4 || undefined,
        qualityLevel: currentQualityLevel(),
        costTime: costTimeMs > 0 ? costTimeMs : undefined,
    });
    playSessionStartedAt = Date.now();
    if (playSessionHeartbeatTimer) clearInterval(playSessionHeartbeatTimer);
    playSessionHeartbeatTimer = setInterval(() => {
        if (!playSessionId || !activePlayConfig) return;
        const body = {
            sessionId: playSessionId,
            ...playSessionAuthFields(activePlayConfig),
            // Reflects a P2P->edge fallback since the session opened.
            path: activePlaybackPathName || 'edge',
            // Running rebuffering totals for this session.
            lagCount: lagTracker.count,
            lagDurationMs: Math.round(lagTracker.durationMs),
        };
        // Start reporting the measured P2P delay only after playback has run
        // for a minute - the first readings are noisy while the jitter buffer
        // and clock sync settle. Only fresh, plausible values may be sent:
        // an implausible one is a clock/reconnect artifact and must not enter
        // the server-side average. ppcenter keeps the last non-zero value, so
        // a heartbeat without one does not clear it.
        const p2pDelayMs = freshPlausibleP2PDelayMs();
        if (playSessionStartedAt && Date.now() - playSessionStartedAt > 60000 &&
            p2pDelayMs != null) {
            body.p2pDelayMs = Math.round(p2pDelayMs);
        }
        postPlaySession('/v1/play/session/heartbeat', body);
    }, 20000);
}

function stopPlaySession(reason = 'client_stopped', { beacon = false } = {}) {
    if (playSessionHeartbeatTimer) {
        clearInterval(playSessionHeartbeatTimer);
        playSessionHeartbeatTimer = null;
    }
    if (playSessionId && activePlayConfig) {
        postPlaySession('/v1/play/session/stop', {
            sessionId: playSessionId,
            ...playSessionAuthFields(activePlayConfig),
            endReason: reason,
            lagCount: lagTracker.count,
            lagDurationMs: Math.round(lagTracker.durationMs),
        }, { beacon });
    }
    playSessionId = null;
    playSessionStartedAt = 0;
}

// A tab closing without going through stopStream still delivers a stop via
// the unload beacon, so the online list doesn't linger on a closed tab.
window.addEventListener('pagehide', () => stopPlaySession('client_stopped', { beacon: true }));

// Layer bookkeeping. The layer *choice* is made server-side from the
// bandwidth estimate (see abr_controller.go in ppmmx); this side tracks what
// is playing and what the user has asked for. See abr-engine.mjs.
const abrEngine = new ABREngine();

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
    if (videoPaused) {
        // Audio-only pauses video but keeps the selector on the last video
        // layer. Resume media first; select only when the target differs.
        //
        // The comparison has to happen before lastVideoTrackId is updated:
        // assigning first made this condition always true, so resuming to a
        // *different* layer than the one paused on would report the switch
        // as complete locally without ever sending SELECT_LAYER, leaving
        // client and server disagreeing until the next TRACKS_INFO.
        const resumingSameLayer = (trackId === lastVideoTrackId);
        lastVideoTrackId = trackId;
        controlClient.setMediaState({ video: 'resumed' });
        videoPaused = false;
        if (resumingSameLayer) {
            abrEngine.notifyLayerSwitched(trackId);
            previousTrackType = 'video';
            return;
        }
    } else {
        lastVideoTrackId = trackId;
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
    // A stall means whatever the jitter buffer/network is doing is already
    // out of the catch-up controller's hands - don't fight browser-side
    // recovery with a stale 1.05x once it resumes.
    catchUpController.reset();
    // Only count buffering after playback was actually established (a
    // cold-start waiting before the first frame is not a rebuffer) and while
    // video is meant to be showing (a deliberate pause is not a stall).
    if (firstFrameDecoded && !videoPaused) lagTracker.beginStall();
});

video.addEventListener('playing', () => {
    console.log('[Video] State: PLAYING');
    if (lagTracker.endStall()) {
        console.log(`[Lag] Rebuffering: ${lagTracker.count} event(s), ${Math.round(lagTracker.durationMs)} ms total`);
    }
});

video.addEventListener('pause', () => {
    console.log('[Video] State: PAUSED');
    // A deliberate pause (or teardown) is not a stall.
    lagTracker.cancelStall();
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

document.getElementById('startPlay') || document.getElementById('startBtn').addEventListener('click', () => {
    startStream(true);
});
document.getElementById('stopPlay') || document.getElementById('exitBtn').addEventListener('click', stopStream);
// Enter in the Stream box starts the typed stream, same as the Start button.
if (streamInputEl) {
    streamInputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            startStream(true);
        }
    });
}
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
function requestPlayerFullscreen() {
    if (!video) return Promise.resolve(false);
    const request = video.requestFullscreen || video.webkitRequestFullscreen;
    if (typeof request !== 'function') return Promise.resolve(false);
    try {
        return Promise.resolve(request.call(video)).then(() => true).catch(() => false);
    } catch {
        return Promise.resolve(false);
    }
}
document.getElementById("fullscreenBtn").onclick = () => requestPlayerFullscreen();

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

function captureSnapshot() {
    if (!video.videoWidth || !video.videoHeight) return Promise.resolve(null);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => {
        canvas.toBlob((blob) => {
            if (!blob) return resolve(null);
            downloadBlob(blob, `snapshot-${Date.now()}.png`);
            resolve(blob);
        }, 'image/png');
    });
}

snapshotBtn.onclick = () => {
    if (snapshotBtn.disabled) return;
    captureSnapshot();
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

function toggleRecording() {
    if (mediaRecorder) {
        mediaRecorder.stop();
        return false;
    }
    startRecording();
    return !!mediaRecorder;
}

recordBtn.onclick = () => {
    if (recordBtn.disabled) return;
    toggleRecording();
};

function applyLayerSelection(val) {
    if (val === "auto") {
        abrEngine.setAutoMode(true);
        // Hand selection back to the server. A plain selectLayer() would
        // pin the layer again (it implies manual mode server-side), so
        // resuming from audio-only has to be done before this, not after.
        if (videoPaused || abrEngine.currentTrackId === abrEngine.audioTrackId) {
            const lowestVideo = abrEngine.videoTrackIds[0];
            if (lowestVideo !== undefined) switchMediaTrack(lowestVideo, 'user_resume');
        }
        if (controlClient) controlClient.setABRMode(true);
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
    return true;
}

layerSelect.addEventListener('change', (e) => {
    applyLayerSelection(e.target.value);
});

// Tracks which codec path (see insertCodecTypeSegment above) the active
// session is using - attachSeiTimestampReader needs it to pick the right NAL
// framing (see sei-timestamp.js). No longer surfaced in the UI: with a
// single-codec deployment (see mmx logs - ppobs never publishes a /hevc or
// /h264 sub-path) the badge just repeated "Playback codec: h264" on every
// play click with no useful information behind it.
function updatePlaybackCodecStatus(codecType) {
    activePlaybackCodec = codecType;
    console.log(`[Main] Playback codec: ${codecType}`);
}

// Codec detection (codec-capability.mjs) is local and cached for the page
// lifetime, but it is still async (mediaCapabilities.decodingInfo). Kick it
// off as soon as startStream can - before the token mint / NAT probe / play
// decision round trips - so it overlaps them instead of being one more serial
// step between the play decision and the WHEP handshake. A failed detection
// resolves to h264, the same conservative default selectPlaybackCodec uses.
let playbackCodecPromise = null;
function ensurePlaybackCodec() {
    if (!playbackCodecPromise) {
        playbackCodecPromise = Promise.resolve()
            .then(selectPlaybackCodec)
            .catch((e) => {
                console.warn('[Main] Codec capability detection failed, defaulting to h264:', e && e.message);
                return 'h264';
            });
    }
    return playbackCodecPromise;
}

// Picks the codec from local decode capability (codec-capability.mjs) and
// returns the full WHEP URL for the edge stream base. A codec typed in the
// Stream box (e.g. ".../hevc") takes precedence over capability detection.
async function resolveEdgeWhepUrl(edgeStreamUrl) {
    let codecType = (manualStream && manualStream.codec) || await ensurePlaybackCodec();
    // A forced /hevc must still be one the browser can actually decode: a
    // browser without HEVC decode connects the WHEP session and receives RTP
    // but renders 0 fps, which the stall watchdog then loops on. When HEVC was
    // requested but the local decode probe says h264, drop back to the h264
    // path (the multitrack origin publishes both).
    if (codecType === 'hevc' && (await ensurePlaybackCodec()) !== 'hevc') {
        console.warn('[Main] HEVC requested but this browser cannot decode HEVC; using H264');
        codecType = 'h264';
    }
    return { url: buildEdgeWhepUrl(edgeStreamUrl, codecType), codecType };
}

// One-shot recovery when the edge rejects a WHEP URL (401/403) - typically
// because the edgeStreamUrl token's 8h TTL passed mid-session and the reader's
// reconnect reused the stale URL. The edge now enforces txTime expiry, so
// rather than spin on the same URL, re-mint the viewer token (its own TTL is
// short) and re-resolve the play decision, then reconnect. Runs at most once
// per playback generation; a second rejection just surfaces the error.
async function handleEdgeAuthRejected(generation, err) {
    if (generation !== readerGeneration) return;
    console.warn('[Main] edge WHEP rejected:', err);
    const cfg = activePlayConfig;
    if (edgeAuthRefreshed || !cfg || !cfg.ppcenter || !cfg.appId || !cfg.streamName) {
        statsContainer.innerHTML = `<div style="color: red; text-align: center;">Error: ${err}</div>`;
        return;
    }
    edgeAuthRefreshed = true;
    statsContainer.innerHTML = '<div style="color: #00bcd4; text-align: center;">Refreshing playback route...</div>';
    try {
        let { txTime, txSecret } = cfg;
        try {
            ({ txTime, txSecret } = await mintViewerToken(cfg.ppcenter, cfg.appId, cfg.streamName));
        } catch (e) {
            console.warn('[Main] viewer token refresh failed; re-resolving with the existing token:', e && e.message);
        }
        if (generation !== readerGeneration) return;
        await startFromPpcenter({ ...cfg, txTime, txSecret }, generation, {});
    } catch (e) {
        if (generation !== readerGeneration) return;
        statsContainer.innerHTML = `<div style="color: red; text-align: center;">Error: ${e.message}</div>`;
    }
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
        videoCodec: codecType,
        maxBitrate: 2500, // 初始带宽限制
        // The direct path reads the OBS abs-timestamp SEI out of the encoded
        // bitstream (attachSeiTimestampReader below), which needs the encoded
        // transform - and it DOES consume it, so enabling it here is safe. See
        // ppplayer.mjs's encodedInsertableStreams comment.
        insertableStreams: true,
        onTrack: (evt) => {
            if (generation !== readerGeneration) return;
            if (evt.track.kind === 'video' || evt.track.kind === 'audio') {
                if (video.srcObject !== evt.streams[0]) {
                    video.srcObject = evt.streams[0];
                }
            }
            if (evt.track.kind === 'video') armFirstVideoFrameCallback(generation);
            // The reader above enables encodedInsertableStreams for the SEI
            // reader. Chrome then holds the audio receiver too until something
            // consumes its encoded stream - attach the passthrough or audio is
            // received but never decoded (audible silence, zero samples).
            if (evt.track.kind === 'audio' && evt.receiver) {
                if (attachPassthroughTransform(evt.receiver)) {
                    console.log('[EncodedStreams] audio passthrough attached');
                }
            }
            if (evt.track.kind === 'video' && evt.receiver && evt.receiver !== seiReaderReceiver) {
                if (attachSeiTimestampReader(evt.receiver, (ts) => {
                    reportP2PDelay(ts, 'sei');
                }, activePlaybackCodec)) {
                    seiReaderReceiver = evt.receiver;
                    console.log('[SEI] abs-timestamp reader attached');
                }
            }
        },
        onError: (err, httpStatus) => {
            if (generation !== readerGeneration) return;
            console.error("Reader Error:", err);

            // The edge answers 404 when nothing is published on the codec path
            // we picked. A publisher that left HEVC/H264 multitrack off sits on
            // the bare ".../{stream}" path (no codec segment), and a stream
            // without an HEVC ladder has no ".../hevc" path, so step down
            // hevc -> h264 -> bare instead of retrying a path that cannot exist.
            if (httpStatus === 404 && codecPathFallback) {
                const next = nextCodecPathCandidate(url);
                if (next) {
                    console.warn(`[Main] no stream on ${url}; trying ${next.url}`);
                    if (reader) reader.close();
                    negotiateAndConnect(generation, next.url, next.codecType);
                    return;
                }
            }

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
            // Report the failed connection (no frame ever arrived on this path).
            reportPlayOutcome(activePlayConfig, activePlaybackPathName || 'edge', { isOK: false, reason: String(err) });
            // Force audio-only on connection failure to save bandwidth
            if (abrEngine && abrEngine.audioTrackId && abrEngine.currentTrackId !== abrEngine.audioTrackId) {
                console.warn("[Main] Connection lost, forcing audio-only mode");
                if (controlClient) switchMediaTrack(abrEngine.audioTrackId, 'connection_lost');
                pauseVideoForAudioOnly();
            }
        },
        onUnauthorized: (err) => {
            // The edge rejected our WHEP URL (401/403) - almost certainly the
            // playback token's txTime expired (edgeStreamUrl TTL is 8h). The
            // reader has stopped its internal retry; re-mint and reconnect.
            if (generation !== readerGeneration) return;
            handleEdgeAuthRejected(generation, err);
        },
        onConnected: () => {
            if (generation !== readerGeneration || !reader) return;
            activePlaybackPath = reader;
            activePlaybackPathName = 'edge';
            applyPlayoutBuffer(reader.pc, bufferMs);
            const sessionId = reader.sessionId;
            console.log(`[Glue] WHEP Connected. SessionID: ${sessionId}`);
            startupMark('whep-connected');
            if (window.parent) window.parent.postMessage('mmxplayer-connected', '*');
            if (sessionId) {
                openControlClientWhenConnected(reader, url, sessionId, generation);
            }
        }
    });
}

// mmx only accepts the ABR control WebSocket once the WHEP session's own
// ICE/DTLS handshake has finished (session.abrReady), and it holds the request
// in a poll for up to abrReadyWaitTimeout (5s) before answering 409 if it hasn't.
// onConnected fires as soon as the WHEP answer is applied - well before that -
// so dialing the control WS there races mmx's handshake and, on every loss,
// costs a 5s server-side hold plus the client's 3s reconnect backoff before the
// session is even usable. Wait for the reader's peer connection to actually
// report 'connected' (the same event that flips mmx's abrReady), then dial once.
function openControlClientWhenConnected(reader, whepUrl, sessionId, generation) {
    const pc = reader.pc;
    const open = () => {
        if (generation !== readerGeneration || reader !== activePlaybackPath) return;
        initControlClient(whepUrl, sessionId);
    };
    if (!pc || pc.connectionState === 'connected') {
        open();
        return;
    }
    const onState = () => {
        if (pc.connectionState !== 'connected') return;
        pc.removeEventListener('connectionstatechange', onState);
        open();
    };
    pc.addEventListener('connectionstatechange', onState);
}

function resetSessionState() {
    previousTrackType = null;
    firstFrameDecoded = false;
    firstFrameCallbackArmed = false;
    lastP2PDelayMs = null;
    lastP2PDelayAt = 0;
    lastP2PDelaySource = null;
    lastFrameTimestampInfo = null;
    seiReaderReceiver = null;
    p2pSeiReaderAttached = false;
    p2pSeiZeroDecodeStreak = 0;
    p2pSeiWatchdogTrip = null;
    negotiatedCodecs = { audio: null, video: null };
    hevcFallbackUsed = false;
    codecPathFallback = false;
    lastStats = {
        videoBytes: 0, audioBytes: 0,
        videoPacketsLost: 0, audioPacketsLost: 0,
        videoPacketsReceived: 0, audioPacketsReceived: 0,
        timestamp: 0,
    };
    resetLossTotals();
    catchUpController.reset();
    stallWatchdog.reset();
    lagTracker.reset();
}

// A signed P2P link is a URL that carries all five ppcenter params (see
// parsePlayRequest). A partial one is a malformed link, not a normal page:
// report exactly what is wrong in the stats panel - which is always on screen
// - rather than an alert() the viewer has to dismiss first.
function showLinkNotice(message) {
    if (!statsContainer) return;
    const example = 'https://pplayer.pp-cdn.org/?ppcenter=https://api.pp-cdn.org'
        + '&amp;appId=&lt;appId&gt;&amp;streamName=&lt;tableId&gt;-&lt;view&gt;'
        + '&amp;txTime=&lt;hex&gt;&amp;txSecret=&lt;hmac&gt;';
    statsContainer.innerHTML =
        '<div style="padding: 4px;">' +
        '<div style="color: #ffc107; font-weight: bold; margin-bottom: 6px;">Cannot start playback</div>' +
        `<div style="color: #ffc107; margin-bottom: 10px;">${message}</div>` +
        '<div style="color: #888; font-size: 12px; line-height: 1.5;">Signed-link format:<br>' +
        `<code style="word-break: break-all;">${example}</code></div>` +
        '</div>';
}

// The player has three entry points:
//  - the five ppcenter params (signed link): ppcenter's decision names the edge
//    stream base (edgeStreamUrl) + whether P2P is available, and the codec is
//    chosen locally (see startDirectStream).
//  - ?url=<complete WHEP URL>: a direct preview URL (the console's live preview
//    uses this - see PublishSessionsPanel). It is already codec-specific and
//    signed, so it is played verbatim.
//  - the Stream box: a manually typed appId/streamName[/codec]. It is the
//    fallback for a bare page (the console homepage links here with no params)
//    and the override a manual Start uses.
//
// parsePlayRequest enforces all-or-nothing on the five parameters, so a
// half-filled query string is a hard error rather than a silent fallback.
//
// forceManual is set by the Start button (and by a watchdog restart of a manual
// session): it plays whatever is in the Stream box, overriding any signed-link /
// ?url= parameters still in the query string. The automatic start on page open
// passes false so a shared link keeps its precedence.
async function startStream(forceManual = false) {
    startupBegin();
    stopStream();
    const generation = ++readerGeneration;
    edgeAuthRefreshed = false;

    const params = new URLSearchParams(window.location.search);
    const ppcenter = (params.get('ppcenter') || '').trim() || DEFAULT_PPCENTER;

    let playConfig;
    let linkError = null;
    try {
        playConfig = parsePlayRequest(window.location.search);
    } catch (error) {
        // A partial link is malformed, but a manual Start can still recover by
        // playing what is in the Stream box, so defer the error instead of
        // returning here.
        linkError = error;
    }
    const directUrl = playConfig ? null : (params.get('url') || '').trim();

    // WHEP is the only pull format: a ?url= that is not a WHEP URL is refused
    // with an explicit message instead of being handed to the WHEP reader.
    if (directUrl && !forceManual && !isWhepUrl(directUrl)) {
        showLinkNotice(WHEP_ONLY_MESSAGE);
        return;
    }

    // The Stream box is authoritative for a manual Start and for the bare page
    // (no signed link, no ?url=). A signed link / ?url= opened automatically
    // keeps its own parameters and clears any stale box codec override.
    let manual = null;
    const boxUsable = forceManual || (!playConfig && !directUrl && !linkError);
    if (boxUsable) {
        manual = parseStreamInput(streamInputEl && streamInputEl.value);
        if (!manual) {
            showLinkNotice(linkError ? linkError.message
                : looksLikeUrl(streamInputEl && streamInputEl.value) ? WHEP_ONLY_MESSAGE
                : 'Enter a stream as appId/streamName (optionally append /h264 or /hevc)');
            return;
        }
        manualStream = manual;
        lastStartManual = true;
    } else if (linkError) {
        // Malformed link on automatic start: surface it rather than silently
        // falling back to the box's demo stream.
        showLinkNotice(linkError.message);
        return;
    } else {
        // A signed link may carry the stream's codec (?codec=h264|hevc), e.g.
        // the console preview stamps the origin's multitrack path. Honor it so
        // an HEVC stream skips the H264-only P2P attempt and the edge URL keeps
        // the origin's actual codec. The box's own text is not used here.
        const codecParam = (params.get('codec') || '').trim().toLowerCase();
        manualStream = (playConfig && (codecParam === 'h264' || codecParam === 'hevc'))
            ? { appId: playConfig.appId, streamName: playConfig.streamName, codec: codecParam }
            : null;
        lastStartManual = false;
    }

    resetSessionState();
    // Local and cached: start it now so it runs in parallel with the token /
    // probe / decision round trips below (see ensurePlaybackCodec).
    ensurePlaybackCodec();

    if (manual) {
        const { appId, streamName } = manual;
        console.log(`[Main] playing Stream box: ${appId}/${streamName}` +
            (manual.codec ? `/${manual.codec}` : '') + ` @ ${ppcenter}`);
        // The STUN half of the NAT probe needs no token - only its ppcenter
        // submission does (see submitNatProbe) - so start it before the token
        // round trip and overlap the two instead of paying them back to back.
        const natProbeStartedAt = performance.now();
        const natGatherPromise = shouldAttemptP2P(appId, streamName, manual.codec) ? gatherNatProbe(ppcenter) : null;
        try {
            const token = await mintViewerToken(ppcenter, appId, streamName);
            const { txTime, txSecret } = token;
            startupMark('token', token.cached ? '(cached)' : '(minted)');
            if (generation !== readerGeneration) return;
            startTimeSync(ppcenter);
            await startFromPpcenter({
                ppcenter, appId, streamName, txTime, txSecret,
                clientId: newClientId(), requestRegion: '', natProbeId: '',
            }, generation, { natGatherPromise, natProbeStartedAt });
        } catch (error) {
            console.warn('[Main] Stream box playback failed:', error);
            showLinkNotice(`could not start ${appId}/${streamName} (${error.message})`);
        }
        return;
    }

    if (playConfig) {
        startupMark('token', '(provided)');
        startTimeSync(playConfig.ppcenter);
        await startFromPpcenter(playConfig, generation);
        return;
    }
    if (directUrl) {
        startTimeSync(ppcenter);
        await startDirectWhepUrl(directUrl, generation, ppcenter);
        return;
    }
}

// Plays a complete WHEP URL verbatim (the console's ?url= preview). It is
// already codec-specific and signed, so the codec is read off the URL and the
// URL is NOT rewritten - rewriting the codec segment would invalidate its
// signature.
//
// The console preview is a real viewer connection, so it is counted in the
// pull-stream statistics like any signed link: appId/streamName come from the
// signed WHEP path, and a viewer token for the session/outcome endpoints is
// minted from POST /v1/play/link. The WHEP URL's own txSecret cannot be reused
// for that - it is signed over the codec-suffixed path, not the appId/stream
// pair those endpoints verify against. Reporting is best-effort: if the mint
// fails the preview still plays, just uncounted.
async function startDirectWhepUrl(rawUrl, generation, ppcenter) {
    const explicitCodec = String(rawUrl).match(/\/(h264|hevc)\/whep(?:\?|$)/);
    const codecType = explicitCodec ? explicitCodec[1] : 'h264';

    playOutcomeReported = false;
    playOutcomeCondition = null;
    playStartedAt = Date.now();
    firstFrameAt = null;
    playReportIpv4 = '';
    activePlayConfig = null;
    try {
        activeEdgeNodeName = new URL(rawUrl).host;
    } catch {
        activeEdgeNodeName = '';
    }
    const { appId, streamName } = parseWhepStreamInfo(rawUrl);
    if (appId && streamName) {
        try {
            const token = await mintViewerToken(ppcenter, appId, streamName);
            const { txTime, txSecret } = token;
            startupMark('token', token.cached ? '(cached)' : '(minted)');
            if (generation !== readerGeneration) return;
            activePlayConfig = {
                ppcenter, appId, streamName, txTime, txSecret,
                clientId: newClientId(), requestRegion: '', natProbeId: '',
            };
        } catch (error) {
            console.warn('[Main] preview viewer token unavailable; preview will not be counted:', error && error.message);
        }
    }

    statsContainer.innerHTML = '<div style="color: #00bcd4; text-align: center;">Connecting WHEP...</div>';
    negotiateAndConnect(generation, rawUrl, codecType);
    lastStats.timestamp = Date.now();
    statsInterval = setInterval(updateStats, 1000);
}

// Pulls appId/streamName out of a signed WHEP URL's path
// (https://<host>/{appId}/{streamName}/{codec}/whep?...), so the console
// preview can be attributed to the right stream in the pull statistics. Any
// trailing codec segment is optional; a bare /{appId}/{streamName}/whep works
// too.
function parseWhepStreamInfo(rawUrl) {
    try {
        const segments = new URL(rawUrl).pathname.split('/').filter(Boolean);
        if (segments[segments.length - 1] === 'whep') segments.pop();
        if (['h264', 'hevc', 'av1'].includes(segments[segments.length - 1])) segments.pop();
        const streamName = segments.pop() || '';
        const appId = segments.pop() || '';
        return { appId, streamName };
    } catch {
        return { appId: '', streamName: '' };
    }
}

// The edge node name shown in the stats panel. ppcenter now returns it with
// the play decision; older builds only carry the signed WHEP host, which is
// still a useful identifier. P2P pulls deliberately show an empty value.
function edgeNodeNameFromDecision(decision) {
    const name = (decision && decision.edge && decision.edge.nodeName) || '';
    if (name) return String(name);
    const url = (decision && decision.edgeStreamUrl) || '';
    try {
        return url ? new URL(url).host : '';
    } catch {
        return '';
    }
}

// Clock calibration runs for every playback mode: the delay figures are
// meaningless without it (see reportP2PDelay). Failure is non-fatal -
// playback continues and P2P Delay falls back to the RTT estimate.
function startTimeSync(ppcenter) {
    timeSync = new TimeSync({ ppcenter });
    timeSync.start().catch((e) => {
        console.warn('[TimeSync] calibration unavailable:', e && e.message);
    });
}

// Waiting out the NAT probe's full worst case (nat-probe.mjs caps ICE
// gathering at 5000ms) before even asking ppcenter for a play decision means
// every viewer pays that tax up front - including whenever it ends up
// edge-only anyway, which is exactly what happens when the probe is merely
// slow: ppcenter already treats a play request with no natProbeId as "decide
// without it" (PLY-002, the same fallback a failed/errored probe hits today),
// so there is nothing gained by blocking Edge behind a probe that hasn't
// finished. The probe is capped here at NAT_PROBE_GRACE_MS instead: if it
// hasn't resolved by then, the play request goes out with whatever
// natProbeId is (or isn't) available, and the probe keeps running
// unawaited - submitNatProbe posts its result to ppcenter itself, so a
// late resolution still lands in ppcenter's observation store for a future
// attempt (a retry, or the next stream switch), it is just too late to help
// this one. See docs/test/ppcdn-debug-log.md's 2026-09-22 entry.
//
// Note the probe is gather (token-free, local) + submit (needs the token): the
// gather half can therefore be started before the viewer token is even minted,
// which the bare-page path does to overlap the two - see startStream.
async function startFromPpcenter(playConfig, generation, { natGatherPromise = null, natProbeStartedAt = 0 } = {}) {
    const cfg = sdkConfig();
    if (cfg.natProbeGraceMs !== undefined) natProbeGraceMs = clampNatProbeGrace(cfg.natProbeGraceMs);
    playOutcomeReported = false; // one connection report per play
    playOutcomeCondition = null;
    // Pull-stream measures: costTime is from here to the first decoded frame.
    playStartedAt = Date.now();
    firstFrameAt = null;
    activePlayConfig = playConfig;
    playReportIpv4 = '';
    statsContainer.innerHTML = '<div style="color: #00bcd4; text-align: center;">Requesting playback route...</div>';

    // The NAT probe only matters for P2P; when the viewer unchecked it there
    // is nothing to ask ppcenter for, so skip the round trip entirely. P2P also
    // carries H264 only, so an HEVC stream (typed in the box or stamped by the
    // console preview) must go straight to the edge instead of a doomed P2P
    // attempt - requesting without the p2p capability makes ppcenter answer
    // edge-only.
    const p2pKnownUnavailable = isP2PKnownUnavailable(playConfig.appId, playConfig.streamName);
    const wantP2P = shouldAttemptP2P(playConfig.appId, playConfig.streamName, manualStream?.codec);
    let natProbeId = null;
    if (!wantP2P) {
        startupMark('nat-probe', p2pKnownUnavailable ? '(skipped: p2p unavailable)' : '(skipped)');
        if (p2pKnownUnavailable) {
            console.log('[P2P] known unavailable for this stream; requesting edge-only without NAT probe');
        }
    }
    if (wantP2P) {
        // PLY-002: report the NAT observation so ppcenter can judge whether a
        // direct connection is even worth attempting. Non-fatal - a failed or
        // still-running probe just means ppcenter decides without it and
        // most likely says edge-only.
        //
        // The viewer's observation must be kind="player" (the publisher
        // observation comes from ppobs; a mislabelled player probe fails
        // eligibility as an identity mismatch). streamName is still sent
        // because the viewer token is signed over appId/streamName and
        // ppcenter verifies it from this field.
        //
        // Gather and submit are split so the (token-free) gather can already
        // be running by the time this function is entered - the bare-page
        // path starts it before minting the viewer token (see startStream).
        // natGatherPromise is that pre-started gather, if any; otherwise the
        // gather starts here.
        const probeStartedAt = natProbeStartedAt || performance.now();
        const gather = natGatherPromise || gatherNatProbe(playConfig.ppcenter);
        const probePromise = gather.then((gathered) => submitNatProbe({
            ppcenter: playConfig.ppcenter,
            appId: playConfig.appId,
            txTime: playConfig.txTime,
            txSecret: playConfig.txSecret,
            clientId: playConfig.clientId,
            streamName: playConfig.streamName,
            kind: 'player',
            gathered,
        })).then((probe) => {
            // Keep the probe's public IPv4 for the pull-stream report.
            if (probe?.ipv4) playReportIpv4 = probe.ipv4;
            return probe?.probeId || null;
        }).catch(() => null);
        // Logged unconditionally, even when it resolves after the grace
        // window below has already moved on - a probeId that shows up here
        // but never made it into a play/requests call is exactly the
        // signature of a slow/unreachable STUN server, which is otherwise
        // invisible from the console (see nat-probe.mjs's own STUN choice).
        probePromise.then((id) => {
            const elapsedMs = Math.round(performance.now() - probeStartedAt);
            console.log(id
                ? `[P2P] NAT probe resolved in ${elapsedMs}ms: ${id}`
                : `[P2P] NAT probe found no usable candidate (${elapsedMs}ms)`);
        });
        const grace = new Promise((resolve) => setTimeout(() => resolve(null), natProbeGraceMs));
        natProbeId = await Promise.race([probePromise, grace]);
        startupMark('nat-probe', natProbeId ? '(ready)' : '(timeout)');
        if (!natProbeId) {
            console.log(`[P2P] NAT probe still pending after the ${natProbeGraceMs}ms grace window; requesting playback without it`);
        }
        if (generation !== readerGeneration) return;
    }

    const abortController = new AbortController();
    playRequestAbortController = abortController;
    try {
        const decision = await requestPlayDecisionWithRetry(playConfig, {
            signal: abortController.signal,
            natProbeId,
            preferP2P: wantP2P,
            onRetry: (attempt) => {
                // Transient no_edge_available: ppcenter hasn't seen the
                // stream's Origin yet (publisher just (re)connected or
                // switched transport). Show it as progress rather than a
                // failure - the retry usually succeeds within a few seconds.
                if (generation !== readerGeneration) return;
                statsContainer.innerHTML = `<div style="color: #00bcd4; text-align: center;">Waiting for stream... (retry ${attempt})</div>`;
            },
        });
        if (playRequestAbortController !== abortController || generation !== readerGeneration) return;
        playRequestAbortController = null;
        const availability = decision.p2pAvailability;
        console.log(`[P2P] ppcenter decision: mode=${decision.mode}` +
            `, p2pAvailable=${decision.p2pAvailable !== false}` +
            (availability ? `, publisherConnected=${availability.publisherConnected}` +
                `, slotsFree=${availability.publisherSlotsFree}/${availability.publisherSlotsMax}` : '') +
            (decision.p2p ? `, stunServers=${JSON.stringify(decision.p2p.stunServers || [])}` : ' (no p2p block offered)') +
            (decision.reason ? `, reason=${decision.reason}` : '') +
            (decision.publisherNat ? `, publisherNat=${decision.publisherNat}` : '') +
            (decision.playerNat ? `, playerNat=${decision.playerNat}` : ''));
        startupMark('decision', `(mode=${decision.mode})`);
        noteP2PDecision(playConfig, decision);
        playOutcomeCondition = {
            reason: decision.reason,
            publisherNat: decision.publisherNat,
            playerNat: decision.playerNat,
        };
        activeEdgeNodeName = edgeNodeNameFromDecision(decision);
        startPlaybackFromDecision(decision, {
            startDirectStream: (url) => {
                // Edge-only: no immediate report - the first decoded frame
                // triggers the success report with a real costTime.
                startDirectStream(url, generation);
            },
            startP2PPlayback: (d) => startP2PPlayback(d, generation, playConfig),
        });
    } catch (error) {
        if (error.name === 'AbortError' || generation !== readerGeneration) return;
        if (/401|403|invalid_viewer_token|viewer_token_expired/i.test(error.message || '')) {
            clearViewerTokenCache(playConfig.ppcenter, playConfig.appId, playConfig.streamName);
        }
        console.error('Play request failed:', error);
        statsContainer.innerHTML = `<div style="color: red; text-align: center;">Error: ${error.message}</div>`;
        reportPlayOutcome(playConfig, 'edge', { isOK: false, reason: error.message });
    }
}

// edgeStreamUrl is ppcenter's edge stream base: bare path (no codec, no
// /whep) but already carrying the txTime/txSecret signature. The codec (and
// therefore the full WHEP URL) is decided here, from the browser's own HEVC
// capability.
async function startDirectStream(edgeStreamUrl, generation) {
    statsContainer.innerHTML = '<div style="color: #00bcd4; text-align: center;">Connecting WHEP...</div>';

    const { url, codecType } = await resolveEdgeWhepUrl(edgeStreamUrl);
    if (generation !== readerGeneration) return; // superseded while awaiting codec detection
    codecPathFallback = true;
    negotiateAndConnect(generation, url, codecType);

    lastStats.timestamp = Date.now();
    statsInterval = setInterval(updateStats, 1000);
}

// Compact, copy-friendly trace of the P2P handshake (absorbed from p2player's
// logSignal). Per-candidate events are dropped as too chatty; the states that
// decide whether a direct connection forms are kept.
function logP2PSignal(m, expectedSessionId) {
    const idNote = m.sessionId ? ` sessionId=${m.sessionId === expectedSessionId ? 'match' : 'MISMATCH'}` : '';
    const tag = '[P2P]';
    switch (m.type) {
        // The handshake's landmarks stay at normal verbosity; the per-step
        // transport state trail and intermediate negotiation steps need ?debug.
        case 'ws-connecting': console.log(`${tag} signaling: connecting to ${m.url}`); break;
        case 'ws-open': console.log(`${tag} signaling: WebSocket open`); break;
        case 'ready': console.log(`${tag} signaling: publisher ready; creating offer`); break;
        case 'answer': console.log(`${tag} answer received (sdp ${(m.sdp || '').length}B)${idNote}`); break;
        case 'track': console.log(`${tag} media track received: ${m.kind}`); break;
        case 'error': console.log(`${tag} signaling error: ${m.reason || 'rejected'}`); break;
        case 'pc-created':
            if (PP_DEBUG) console.log(`${tag} RTCPeerConnection created; iceServers=${JSON.stringify(m.iceServers || [])}`);
            break;
        case 'offer-created':
            if (PP_DEBUG) console.log(`${tag} local offer created (sdp ${m.sdpLength}B); sent to publisher`);
            break;
        case 'remote-description-set':
            if (PP_DEBUG) console.log(`${tag} remote description (answer) applied`);
            break;
        case 'iceconnectionstate':
        case 'connectionstate':
        case 'signalingstate':
        case 'icegatheringstate':
            if (PP_DEBUG) console.log(`${tag} ${m.type}=${m.value}`);
            break;
        default: break; // local-candidate / ice are per-candidate, too chatty
    }
}

// ppcenter decides the path - there is no client-side racing. A p2p-connect
// decision means ppcenter judged this pair traversable AND the publisher has a
// free P2P slot, so playback connects P2P alone; the edge URL carried in the
// same decision is used only as a SEQUENTIAL fallback if P2P fails or never
// decodes, never in parallel.
//
// How long to wait for the publisher's answer before giving up on the P2P leg.
// Fixed (not derived from connectTimeoutMs, which bounds the ICE connect after
// an answer): the moment the offer is handed to ppcenter the publisher is
// either going to answer promptly or not at all, and a viewer staring at
// "Connecting P2P..." cares about this window, not the transport's.
const P2P_HANDSHAKE_TIMEOUT_MS = 5000;

function startP2PPlayback(decision, generation, playConfig) {
    statsContainer.innerHTML = '<div style="color: #00bcd4; text-align: center;">Connecting P2P...</div>';
    lastStats.timestamp = Date.now();
    statsInterval = setInterval(updateStats, 1000);

    // Encoded insertable streams on by default (?p2psei=0 to opt out). Some
    // Chrome builds can fire ontrack and complete ICE while the encoded
    // transform still prevents any frame from reaching the decoder (video
    // stays 2x2, framesDecoded=0 forever) - this used to mean turning the
    // transform on risked an otherwise-working P2P session hanging well past
    // the generic "no frame within grace window" fallback (graceMs below,
    // 4-6+s). p2pSeiWatchdogTrip (armed below, checked in updateStats) now
    // catches that exact signature - packets arriving, framesDecoded stuck at
    // 0 - in P2P_SEI_STALL_SECONDS and reverts to edge via the same
    // fallbackToEdge every other P2P failure uses, well before the generic
    // timer would. On a browser where the transform behaves normally this
    // never trips, and reportP2PDelay gets a real SEI-derived value instead
    // of the RTT/jitter estimate.
    const p2pSeiEnabled = new URLSearchParams(window.location.search).get('p2psei') !== '0';
    const path = createDirectP2PPlayback(decision, {
        bufferMs,
        WebSocketClass: WebSocket,
        PeerConnectionClass: RTCPeerConnection,
        insertableStreams: p2pSeiEnabled,
        onVideoReceiver: p2pSeiEnabled ? (receiver) => {
            if (p2pSeiReaderAttached) return;
            p2pSeiReaderAttached = attachSeiTimestampReader(receiver, (ts) => {
                reportP2PDelay(ts, 'sei');
            }, 'h264');
            if (p2pSeiReaderAttached) console.log('[SEI] abs-timestamp reader attached (P2P)');
        } : undefined,
    });
    activePlaybackPath = path;
    activePlaybackPathName = 'p2p';
    if (layerSelect) layerSelect.disabled = true;
    playbackRace = null;

    let settled = false;
    let verifyTimer = null;
    let handshakeTimer = null;

    const fallbackToEdge = (reason) => {
        if (settled || generation !== readerGeneration) return;
        settled = true;
        if (verifyTimer) clearTimeout(verifyTimer);
        if (handshakeTimer) clearTimeout(handshakeTimer);
        if (statsInterval) clearInterval(statsInterval);
        console.warn('[P2P] direct P2P did not play, falling back to edge:', reason);
        try { path.stop('p2p_failed'); } catch { /* best-effort */ }
        activePlaybackPath = null;
        activePlaybackPathName = 'edge';
        // No report here: the edge first frame will report the success with a
        // real costTime, or negotiateAndConnect's onError reports the failure.
        startDirectStream(decision.edgeStreamUrl, generation);
    };

    // Armed only when the transform is actually attached - see
    // p2pSeiZeroDecodeStreak's declaration for why updateStats (not a closure
    // here) is what calls this.
    p2pSeiZeroDecodeStreak = 0;
    p2pSeiWatchdogTrip = p2pSeiEnabled
        ? () => fallbackToEdge(`P2P SEI transform appears to block decode (framesDecoded stuck at 0 for ${P2P_SEI_STALL_SECONDS}s while packets were arriving)`)
        : null;

    // Bound the P2P handshake itself (offer -> publisher answer -> first track).
    // onNegotiated fires as soon as the answer's remote track is applied, which
    // is well before ICE finishes, so this timer only catches "the publisher
    // never answered". On timeout fallbackToEdge() stops the path, which sends a
    // close to the publisher through ppcenter and then closes the signaling
    // WebSocket - so a publisher that accepted the offer and went silent frees
    // its slot immediately instead of the viewer waiting for the server's own
    // session TTL. The edge URL in the same decision is the sequential fallback.
    handshakeTimer = setTimeout(
        () => fallbackToEdge(`no P2P answer within ${P2P_HANDSHAKE_TIMEOUT_MS}ms; closing signaling`),
        P2P_HANDSHAKE_TIMEOUT_MS);

    path.start({
        onSignal: (message) => logP2PSignal(message, decision.p2p.sessionId),
        onNegotiated: ({ stream }) => {
            if (generation !== readerGeneration) return;
            if (handshakeTimer) {
                clearTimeout(handshakeTimer);
                handshakeTimer = null;
            }
            video.srcObject = stream;
            video.play().catch((err) => {
                if (err && err.name === 'AbortError') return;
                console.warn('[P2P] play() after srcObject failed:', err);
            });
            startupMark('p2p-negotiated');
            applyPlayoutBuffer(path.pc, bufferMs);
            statsContainer.innerHTML = '<div style="color: #00bcd4; text-align: center;">Playing via P2P</div>';
            // Report p2p only once a frame is actually presented - a
            // connected-but-never-decoding P2P must count as edge in the
            // penetration metric (same rule as the old race controller).
            if (typeof video.requestVideoFrameCallback === 'function') {
                video.requestVideoFrameCallback(() => {
                    if (settled || generation !== readerGeneration) return;
                    settled = true;
                    if (firstFrameAt === null) firstFrameAt = Date.now();
                    startupMark('first-frame');
                    if (verifyTimer) clearTimeout(verifyTimer);
                    reportPlayOutcome(playConfig, 'p2p');
                });
            } else {
                settled = true;
                if (firstFrameAt === null) firstFrameAt = Date.now();
                startupMark('first-frame');
                reportPlayOutcome(playConfig, 'p2p');
            }
            const graceMs = Math.max(4000, Number(decision.p2p?.connectTimeoutMs || 0) + 2000);
            verifyTimer = setTimeout(() => fallbackToEdge('no frame within grace window'), graceMs);
        },
        onFailed: (error) => fallbackToEdge(error),
    });
}

// Kept for rollback: the previous edge-primary + background-P2P upgrade. No
// longer wired to the play decision (see startPlaybackFromDecision).
function startRacedPlayback(decision, generation, playConfig) {
    statsContainer.innerHTML = '<div style="color: #00bcd4; text-align: center;">Connecting P2P and Edge...</div>';
    lastStats.timestamp = Date.now();
    statsInterval = setInterval(updateStats, 1000);

    const playback = createPlaybackRace(decision, {
        bufferMs,
        ReaderClass: MediaMTXWebRTCReader,
        // The on-screen P2P trial is off by default: a P2P leg that cannot
        // decode blanks the viewer for p2pVerifyMs then reverts (a visible
        // flash) for no gain. P2P still connects in the background (diagnosable
        // from stats / ppobs logs); opt into the visible trial with ?p2ptrial=1
        // once P2P decode is expected to work.
        enableVisibleTrial: new URLSearchParams(window.location.search).get('p2ptrial') === '1',
        onSelected: ({ path }) => {
            if (generation !== readerGeneration) return;
            console.log(`[P2P] race selected: ${path}`);
            const selected = path === 'p2p' ? playback.p2pPath : playback.edgePath;
            activePlaybackPath = selected;
            activePlaybackPathName = path;
            if (selected.stream && video.srcObject !== selected.stream) {
                video.srcObject = selected.stream;
                // Assigning srcObject re-runs the element's load algorithm and
                // leaves it paused. `autoplay` covers the first load; a path
                // switch (edge -> P2P trial -> back to edge) is a later one, so
                // ask explicitly instead of handing the viewer a frozen frame.
                // The element is muted, so this cannot trip the autoplay policy.
                // A rapid trial->revert swaps srcObject again before this play()
                // settles, which rejects the pending promise with AbortError -
                // expected and harmless (the next swap's own play() takes over),
                // so swallow just that one and let real failures surface.
                video.play().catch((err) => {
                    if (err && err.name === 'AbortError') return;
                    console.warn('[P2P] play after path switch failed:', err);
                });
            }
            // The visible element is now this stream's consumer, so the
            // private sink the path used to get itself decoded during the
            // race can go - otherwise the same stream decodes twice. See
            // createDecodeSink in playback-paths.mjs.
            selected.releaseDecodeSink?.();
            // The path already applied the buffer on its own track event;
            // this call only reports which API took it now that a winner
            // exists.
            applyPlayoutBuffer(selected.pc, bufferMs);
            // ABR layer control only exists on the Edge leg: the first-phase
            // P2P link carries a single video layer (PLY-009).
            if (path === 'edge' && selected.sessionId) {
                initControlClient(decision.edgeStreamUrl, selected.sessionId);
            } else {
                layerSelect.disabled = true;
            }
            statsContainer.innerHTML =
                `<div style="color: #00bcd4; text-align: center;">Playing via ${path.toUpperCase()}</div>`;
        },
        onFailed: (error) => {
            if (generation !== readerGeneration) return;
            console.error('Playback race failed:', error);
            statsContainer.innerHTML = `<div style="color: red; text-align: center;">Error: ${error.message}</div>`;
        },
        // console.log, not console.debug: Chrome files console.debug under
        // the Verbose level, which its console hides by default - so every
        // race event (race_started / path_first_frame / path_failed /
        // path_timeout / race_failed) was being emitted but was invisible
        // in practice, including while debugging this path in production on
        // 2026-09-22. These are the only window into why a race picked what
        // it picked; they need to be visible by default, and tagged [P2P]
        // like the other P2P-lifecycle logs here.
        onTelemetry: (event) => {
            console.log('[P2P] race event:', JSON.stringify(event));
            // Count the true outcome once the controller settles: P2P only if
            // it actually committed to the P2P leg; edge if it gave up on P2P
            // or reverted. reportPlayOutcome is guarded to fire once per play.
            if (event.event === 'p2p_committed') reportPlayOutcome(playConfig, 'p2p');
            else if (event.event === 'p2p_give_up' || event.event === 'p2p_reverted' ||
                     event.event === 'p2p_trial_suppressed') reportPlayOutcome(playConfig, 'edge');
        },
    });
    playbackRace = playback.controller;
    playbackRace.start();
}

function initControlClient(whepUrl, sessionId) {
    // A P2P trial that reverts re-selects the same, never-stopped edge leg, so
    // onSelected calls this again with the session it is already connected to.
    // Tearing that control channel down and redialing it drops the layer list
    // and resets ABR for no reason; keep the live one instead.
    if (controlClient && controlClient.sessionId === sessionId) return;
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
            if (pendingQualityTarget !== null) {
                const queued = pendingQualityTarget;
                pendingQualityTarget = null;
                apiSwitchQuality(queued);
            }
            if (typeof window !== 'undefined' && typeof window.pplayer?.onTracksInfo === 'function') {
                try { window.pplayer.onTracksInfo(tracks, activeId); } catch (e) {
                    console.warn('[pplayer] onTracksInfo callback failed:', e);
                }
            }
        },
        onObsTimestamp: (data) => {
            // Fallback path (see comment above lastP2PDelayMs) - only used
            // when SEI reading isn't available. mmx extracts and broadcasts
            // one timestamp per path regardless of which simulcast layer
            // produced it (see obs-timestamp.mjs) - every layer encodes the
            // same source frame at essentially the same wall-clock time, so
            // this is accurate enough without per-layer rid matching.
            if (!isValidObsTimestampMessage(data)) return;
            reportP2PDelay(data.timestamp, 'relay');
        },
        onABRMode: (auto) => {
            // The server is authoritative about who is choosing layers -
            // it flips to manual on any SELECT_LAYER, including ones this
            // client sent, so adopt its view rather than tracking our own.
            abrEngine.notifyAutoMode(auto);
            if (!layerSelect.disabled) {
                updateLayerSelectUI(controlClient ? controlClient.tracks : [], abrEngine.currentTrackId);
            }
            updateActionButtonsState();
        },
        onBandwidthEstimate: (bps) => {
            abrEngine.notifyBandwidthEstimate(bps);
        },
        onAbrRecommend: (trackId) => {
            // The server only ever recommends; this client is the one that
            // actually asks mmx to switch, via the same switchMediaTrack
            // path a manual pick uses - see ppplayer.mjs's ABR_RECOMMEND
            // case and runABRControl's doc comment in ppmmx for why. If the
            // user has since taken manual control, or a manual switch is
            // still in flight, a stale recommendation must not undo it.
            if (!abrEngine.isAutoMode) return;
            if (abrEngine.pendingTrackId !== null) return;
            // The user deliberately paused video (audio-only): switchMediaTrack
            // unconditionally resumes video whenever videoPaused is true, so an
            // automatic recommendation arriving while paused would silently
            // undo that choice. Bandwidth recommendations resume on their own
            // once the user un-pauses.
            if (videoPaused) return;
            switchMediaTrack(trackId, ABR_REASON_AUTO_BANDWIDTH);
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
    // Close the online viewer session before tearing down the connection, so
    // the console list updates immediately instead of after the heartbeat
    // window. Uses the config captured when the session opened.
    stopPlaySession('client_stopped');
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
    if (playRequestAbortController) {
        playRequestAbortController.abort();
        playRequestAbortController = null;
    }
    if (timeSync) {
        timeSync.stop();
        timeSync = null;
    }
    if (controlClient) {
        controlClient.close();
        controlClient = null;
    }
    // A race owns both of its legs, including the reader inside the Edge
    // leg, so stopping it must not be followed by closing that reader again.
    const race = playbackRace;
    playbackRace = null;
    if (race) {
        race.stop();
    } else if (reader) {
        reader.close();
    }
    reader = null;
    activePlaybackPath = null;
    activePlaybackPathName = 'edge';
    activeEdgeNodeName = '';
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
    }
    video.srcObject = null;
    catchUpController.reset();
    stallWatchdog.reset();
    lagTracker.reset();
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
    // In raced mode the winning leg owns the PeerConnection; in direct mode
    // it's the reader. activePlaybackPath covers both once media is flowing.
    const pc = (activePlaybackPath && activePlaybackPath.pc) || (reader && reader.pc);
    if (!pc) return;
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

        // Candidate pairs: a browser keeps every pair that ever reached
        // "succeeded" - e.g. the UDP media path plus a backup TCP/IPv6 one -
        // and only the pair the transport actually selected carries media.
        // Taking the last succeeded pair reported by forEach showed that
        // backup's RTT (a 377ms pair) instead of the ~36ms path in use.
        // Resolve the selected pair explicitly, in order of trust.
        let selectedPairId = null;
        let selectedPair = null;
        let nominatedPair = null;
        let anySucceededPair = null;

        stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') videoStats = report;
            if (report.type === 'inbound-rtp' && report.kind === 'audio') audioStats = report;
            if (report.type === 'transport' && report.selectedCandidatePairId) {
                selectedPairId = report.selectedCandidatePairId;
            }
            if (report.type === 'candidate-pair') {
                if (report.selected === true) selectedPair = report;
                if (report.nominated === true && report.state === 'succeeded') nominatedPair = report;
                if (report.state === 'succeeded') anySucceededPair = report;
            }
            // [新增] 收集 codec 信息
            // Only present once media has flowed on that track; see
            // negotiatedCodecs above for why that isn't enough on its own.
            if (report.type === 'codec') {
                codecs.set(report.id, report.mimeType); // e.g. "video/H264"
            }
        });

        networkStats = (selectedPairId && stats.get(selectedPairId)) ||
            selectedPair || nominatedPair || anySucceededPair;

        // --- 计算实时指标 ---
        let videoKbps = 0;
        let audioKbps = 0;
        let fps = 0;
        let currentPacketLoss = 0;

        let videoLoss = 0;
        let audioLoss = 0;

        if (videoStats) {
            videoKbps = ((videoStats.bytesReceived - lastStats.videoBytes) * 8 / deltaTime / 1000);
            fps = videoStats.framesPerSecond || 0;
            const vLoss = (videoStats.packetsLost || 0) - (lastStats.videoPacketsLost || 0);
            const vRecv = (videoStats.packetsReceived || 0) - (lastStats.videoPacketsReceived || 0);
            // packetsLost can go backwards (a retransmit filling a gap the
            // browser had already counted), and both counters reset on the
            // internal WHEP reconnect - clamp instead of feeding a negative
            // delta into the totals.
            if (vLoss > 0) { videoLoss = vLoss; currentPacketLoss += vLoss; }
            if (vRecv > 0) lossTotals.videoRecv += vRecv;
            lossTotals.videoLost += videoLoss;
            lastStats.videoBytes = videoStats.bytesReceived;
            lastStats.videoPacketsLost = videoStats.packetsLost || 0;
            lastStats.videoPacketsReceived = videoStats.packetsReceived || 0;

            // See p2pSeiWatchdogTrip's declaration: packets arriving (vRecv,
            // this tick's delta - cumulative packetsReceived alone would stay
            // "true" forever after the first packet, including after a real
            // stall unrelated to this) but framesDecoded cumulatively still
            // zero, for P2P_SEI_STALL_SECONDS straight ticks, is exactly the
            // "transform is holding every frame" signature - a real decode
            // stall after frames were already flowing is the unrelated
            // generic StallWatchdog's job (gated on firstFrameDecoded).
            if (p2pSeiWatchdogTrip) {
                if (vRecv > 0 && (videoStats.framesDecoded || 0) === 0) {
                    p2pSeiZeroDecodeStreak++;
                    if (p2pSeiZeroDecodeStreak >= P2P_SEI_STALL_SECONDS) {
                        const trip = p2pSeiWatchdogTrip;
                        p2pSeiWatchdogTrip = null; // one-shot - never retried this session
                        p2pSeiZeroDecodeStreak = 0;
                        trip();
                    }
                } else {
                    p2pSeiZeroDecodeStreak = 0;
                    if ((videoStats.framesDecoded || 0) > 0) p2pSeiWatchdogTrip = null; // real decode started; nothing left to watch for
                }
            }
        }

        // TEMPORARY (2026-09-30): P2P decode diagnosis - remove once the P2P
        // "connects but no frame" regression is understood. 1Hz (updateStats'
        // cadence), only while the P2P leg is the active path, and only with
        // ?debug since it otherwise spams one line per second.
        if (PP_DEBUG && activePlaybackPathName === 'p2p' && videoStats) {
            console.log(`[P2P-Stats] recv=${videoStats.packetsReceived || 0} bytes=${videoStats.bytesReceived || 0} framesReceived=${videoStats.framesReceived || 0} framesDecoded=${videoStats.framesDecoded || 0} fps=${videoStats.framesPerSecond || 0} lost=${videoStats.packetsLost || 0} nack=${videoStats.nackCount || 0}`);
        }

        if (audioStats) {
            audioKbps = ((audioStats.bytesReceived - lastStats.audioBytes) * 8 / deltaTime / 1000);
            const aLoss = (audioStats.packetsLost || 0) - (lastStats.audioPacketsLost || 0);
            const aRecv = (audioStats.packetsReceived || 0) - (lastStats.audioPacketsReceived || 0);
            if (aLoss > 0) { audioLoss = aLoss; currentPacketLoss += aLoss; }
            if (aRecv > 0) lossTotals.audioRecv += aRecv;
            lossTotals.audioLost += audioLoss;
            lastStats.audioBytes = audioStats.bytesReceived;
            lastStats.audioPacketsLost = audioStats.packetsLost || 0;
            lastStats.audioPacketsReceived = audioStats.packetsReceived || 0;
        }

        lastStats.timestamp = now;

        // Video is expected to actually be decoding right now only when
        // it's not deliberately paused and the ABR engine isn't parked on
        // its audio-only track - both of those legitimately read fps=0
        // without being a stall.
        const isVideoActive = !videoPaused &&
            !(abrEngine && abrEngine.currentTrackId === abrEngine.audioTrackId);
        // The stall watchdog only starts after the first video frame has been
        // decoded. The edge-primary model selects edge on WHEP connection,
        // before any frame arrives, so fps=0 during the cold-start window is
        // expected — not a stall. Once normal playback is established, the
        // watchdog detects the real stuck-while-receiving scenario.
        if (fps > 0) {
            firstFrameDecoded = true;
            // First decoded video frame: report the connection success (with a
            // real costTime) once, for whichever path is on screen. Covers the
            // edge path and the P2P fallback; the P2P leg also reports from its
            // own requestVideoFrameCallback (the report is once-guarded).
            if (firstFrameAt === null) {
                firstFrameAt = Date.now();
                startupMark('first-frame');
                reportPlayOutcome(activePlayConfig, activePlaybackPathName || 'edge');
            }
        }
        if (firstFrameDecoded) stallWatchdog.update(videoKbps, fps, isVideoActive);

        // No client-side ABR decision here any more: the layer is chosen
        // server-side from the bandwidth estimate. fps/loss below are
        // reported for statistics and drive the stall watchdog only.

        // currentRoundTripTime is in seconds, and this is the MEDIA path: the
        // selected candidate pair's RTCP-measured round trip (viewer <-> edge
        // node, or <-> publisher over P2P). It is NOT the ppcenter clock-sync
        // RTT (TimeSync's is a different endpoint and several times smaller),
        // so the two are not comparable.
        //
        // Only the selected pair is trusted. The old fallback - "smallest
        // positive RTT among every succeeded candidate pair" - picked a
        // backup/relayed pair (e.g. a 377ms TCP/IPv6 pair) whenever the media
        // pair's own sample was momentarily 0/absent, inventing an RTT the in-
        // use path never had. A recvonly P2P leg genuinely has no RTCP sample
        // much of the time; "—" (unknown) is honest, a backup pair's RTT is
        // not.
        const pairRttSeconds = networkStats?.currentRoundTripTime;
        const rttMs = Number.isFinite(pairRttSeconds) && pairRttSeconds > 0 ? pairRttSeconds * 1000 : null;
        const jitterBufferMs = videoStats?.jitterBufferDelay && videoStats?.jitterBufferEmittedCount
            ? (videoStats.jitterBufferDelay / videoStats.jitterBufferEmittedCount) * 1000
            : 0;
        // Fallback only. Both playback legs now read the OBS SEI (the P2P
        // leg via insertableStreams - see startP2PPlayback), so a real
        // measurement is preferred whenever it is fresh and plausible; this
        // RTT/jitter estimate covers the cold-start window and browsers
        // without encoded insertable streams, and is labelled "(est.)". It
        // carries the same fixed compensation as a real measurement so the
        // two are on the same scale.
        const playoutBufferMs = Number.isFinite(bufferMs) ? bufferMs : 0;
        const estimatedP2PDelayMs = (rttMs ?? 0) / 2 + Math.max(jitterBufferMs, playoutBufferMs) +
            P2P_DELAY_FIXED_COMPENSATION_MS;

        // --- 渲染 UI ---
        let html = '';

        // Which path is actually carrying media right now: "p2p" (direct to
        // the publisher, selected by the race) or "edge-node" (via the edge).
        // activePlaybackPathName is maintained by the reader/race already (it
        // is also what latency reporting uses).
        html += renderStatGroup('Connection', {
            'Type': activePlaybackPathName === 'p2p' ? 'p2p' : 'edge-node',
            'edge-node-name': activePlaybackPathName === 'p2p' ? '' : (activeEdgeNodeName || '')
        });

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
                'FPS': fps.toFixed(1)
            });
        }

        if (audioStats) {
            // [新增] 获取 Audio Codec 名称
            const aMime = audioStats.codecId && codecs.get(audioStats.codecId);
            const aCodec = (aMime && aMime.split('/')[1]) || negotiatedCodecs.audio || 'N/A';

            html += renderStatGroup('Audio', {
                'Codec': aCodec, // [显示]
                'Recv Bitrate': `${audioKbps.toFixed(0)} kbps`,
                'Jitter': `${(audioStats.jitter * 1000).toFixed(1)} ms`
            });
        }

        if (networkStats) {
            const p2pFresh = lastP2PDelayMs !== null && (Date.now() - lastP2PDelayAt) < P2P_DELAY_STALE_MS;
            // A fresh measurement outside [MIN_PLAUSIBLE, MAX_PLAUSIBLE] is a
            // clock artifact rather than a real delay (see the const comments
            // above) - fall back to the RTT/jitter-buffer estimate instead of
            // showing a negative or absurdly large number.
            const p2pImplausible = p2pFresh &&
                (lastP2PDelayMs < P2P_DELAY_MIN_PLAUSIBLE_MS || lastP2PDelayMs > P2P_DELAY_MAX_PLAUSIBLE_MS);
            // The real measurement (SEI whenever encoded streams are
            // available, otherwise the server relay) wins whenever it is
            // fresh and plausible; the RTT + jitter-buffer estimate only
            // covers the cold-start window / unsupported browsers and is
            // always labelled "(est.)" so it is never mistaken for a
            // measurement.
            const p2pLabel = !p2pFresh || p2pImplausible
                ? `~${estimatedP2PDelayMs.toFixed(0)} ms (est.)`
                : `${lastP2PDelayMs.toFixed(0)} ms (${lastP2PDelaySource === 'sei' ? 'SEI' : 'Relay'})`;

            // Only chase a measurement that's both fresh and plausible - the
            // same gate the displayed label uses. The RTT/jitter-buffer
            // estimate is deliberately not used here even as a fallback: it
            // already includes the jitter buffer, so it can't distinguish
            // "buffer is at its configured size" from "buffer has grown and
            // needs draining", which is exactly what catch-up needs to tell
            // apart.
            catchUpController.update(p2pFresh && !p2pImplausible ? lastP2PDelayMs : null);

            // No "Est. Bandwidth" row: the server no longer decides ABR from a
            // bandwidth estimate (it uses loss/RTT), and GCC's send-side
            // estimate is unreliable here (it needs a pacer the deployment
            // skips for latency), so it read 100kbps..20000kbps at random.
            // The real throughput is already shown per track as "Recv Bitrate".
            //
            // Video load time is the same costTime the outcome beacon reports:
            // the wall-clock gap from sending the play request (playStartedAt)
            // to decoding the first video frame (firstFrameAt). It stays at its
            // settled value for the rest of the session, so it is a cold-start
            // metric rather than a live one.
            const videoLoadTimeMs = (playStartedAt && firstFrameAt)
                ? Math.max(0, firstFrameAt - playStartedAt)
                : null;
            const netRows = {
                'Video Load Time': {
                    text: videoLoadTimeMs === null ? '--' : `${videoLoadTimeMs} ms`,
                    title: 'Time from sending the play request to decoding the first video frame (the same costTime reported to ppcenter).',
                },
                // Media-path RTT only (see above): the selected candidate
                // pair's own RTCP sample. Sub-millisecond paths read "<1 ms"
                // rather than a rounded "0.0 ms", and "—" means the selected
                // pair has no fresh sample (common on a recvonly P2P leg),
                // NOT that the path is broken. The title notes the source so
                // it is not confused with TimeSync's (much smaller) ppcenter
                // clock-sync RTT.
                'RTT (media)': {
                    text: rttMs === null ? '—' : (rttMs < 1 ? '<1 ms' : `${rttMs.toFixed(1)} ms`),
                    title: 'Media-path RTT: the selected WebRTC candidate pair\'s round-trip (viewer <-> edge node, or <-> publisher over P2P). Not the ppcenter clock-sync RTT (TimeSync), which is a different, smaller number.',
                },
                'P2P Delay': p2pLabel + (catchUpController.catchingUp ? ' (catching up)' : '')
            };
            html += renderStatGroup('Network', netRows);
        }

        if (html) statsContainer.innerHTML = html;

        // ── LATENCY_REPORT: send e2e metrics to server every second ──
        if (controlClient && controlClient.ws && controlClient.ws.readyState === WebSocket.OPEN) {
            const loss = currentPacketLoss;
            const fpsVal = videoStats?.framesPerSecond || 0;

            controlClient.sendLatencyReport({
                rtt_ms: rttMs ?? 0,
                jitter_buffer_ms: jitterBufferMs,
                // packets_lost stays the audio+video sum for wire compat; the
                // split is what is actually diagnostic. Audio is forwarded as
                // raw RTP end-to-end while video is re-packetized (and NACK-
                // repaired) on every hop, so the two numbers answer different
                // questions - summing them hides which leg is lossy.
                packets_lost: loss,
                audio_packets_lost: audioLoss,
                video_packets_lost: videoLoss,
                audio_loss_pct: lossRatePct(lossTotals.audioLost, lossTotals.audioRecv) ?? 0,
                video_loss_pct: lossRatePct(lossTotals.videoLost, lossTotals.videoRecv) ?? 0,
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
        // A value may be a plain string, or {text, title} to attach a tooltip
        // explaining where the number comes from (e.g. the media-path RTT).
        const isObj = value && typeof value === 'object';
        const text = isObj ? value.text : value;
        const tip = isObj && value.title ? ` title="${value.title}"` : '';
        rows += `<div class="stat-row"${tip}><span class="stat-key">${key}:</span><span class="stat-val">${text}</span></div>`;
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

function normalizeSdkPlayOptions(input) {
    if (input && typeof input === 'object') return { ...input };
    const raw = String(input || '').trim();
    if (!raw) return {};
    if (looksLikeUrl(raw)) return { url: raw };
    const parsed = parseStreamInput(raw);
    if (parsed) return { ...parsed };
    return { stream: raw };
}

function normalizeCodecName(value) {
    const codec = String(value || '').trim().toLowerCase();
    return (codec === 'h264' || codec === 'hevc') ? codec : '';
}

async function apiPlay(input = {}) {
    const opts = normalizeSdkPlayOptions(input);
    startupBegin();
    const cfg = sdkConfig();
    if (opts.natProbe !== undefined) cfg.natProbe = opts.natProbe !== false;
    if (opts.natProbeGraceMs !== undefined) cfg.natProbeGraceMs = clampNatProbeGrace(opts.natProbeGraceMs);
    if (opts.tokenCache !== undefined) cfg.tokenCache = opts.tokenCache !== false;
    if (cfg.natProbeGraceMs !== undefined) natProbeGraceMs = clampNatProbeGrace(cfg.natProbeGraceMs);
    const ppcenter = String(opts.ppcenter || DEFAULT_PPCENTER).trim() || DEFAULT_PPCENTER;
    let codec = normalizeCodecName(opts.codec);

    if (opts.p2p !== undefined && p2pCheckbox) {
        p2pCheckbox.checked = opts.p2p !== false;
    }

    if (opts.url) {
        const url = String(opts.url).trim();
        if (!isWhepUrl(url)) throw new Error(WHEP_ONLY_MESSAGE);
        stopStream();
        const generation = ++readerGeneration;
        edgeAuthRefreshed = false;
        sdkLastPlayOptions = { ...opts, url, ppcenter };
        manualStream = null;
        lastStartManual = false;
        resetSessionState();
        pendingQualityTarget = opts.quality !== undefined ? opts.quality : null;
        await startDirectWhepUrl(url, generation, ppcenter);
        return true;
    }

    let appId = String(opts.appId || '').trim();
    let streamName = String(opts.streamName || '').trim();
    if ((!appId || !streamName) && opts.stream) {
        const parsed = parseStreamInput(opts.stream);
        if (parsed) {
            appId = appId || parsed.appId;
            streamName = streamName || parsed.streamName;
            codec = codec || parsed.codec;
        }
    }
    if (!appId || !streamName) {
        throw new Error('play requires appId + streamName, or a WHEP url');
    }

    stopStream();
    const generation = ++readerGeneration;
    edgeAuthRefreshed = false;
    manualStream = { appId, streamName, codec };
    lastStartManual = true;
    sdkLastPlayOptions = { ...opts, appId, streamName, codec, ppcenter };
    if (streamInputEl) {
        streamInputEl.value = [appId, streamName, codec].filter(Boolean).join('/');
    }

    resetSessionState();
    pendingQualityTarget = opts.quality !== undefined ? opts.quality : null;
    ensurePlaybackCodec();

    const natProbeStartedAt = performance.now();
    const natGatherPromise = shouldAttemptP2P(appId, streamName, codec) ? gatherNatProbe(ppcenter) : null;

    try {
        let { txTime, txSecret } = opts;
        let tokenCached = false;
        const tokenProvided = !!(txTime && txSecret);
        if (!tokenProvided) {
            const token = await mintViewerToken(ppcenter, appId, streamName);
            ({ txTime, txSecret } = token);
            tokenCached = !!token.cached;
        }
        startupMark('token', tokenProvided ? '(provided)' : (tokenCached ? '(cached)' : '(minted)'));
        if (generation !== readerGeneration) return false;
        startTimeSync(ppcenter);
        await startFromPpcenter({
            ppcenter, appId, streamName, txTime, txSecret,
            clientId: newClientId(), requestRegion: '', natProbeId: '',
        }, generation, { natGatherPromise, natProbeStartedAt });
        return true;
    } catch (error) {
        console.warn('[Main] SDK playback failed:', error);
        if (statsContainer) {
            statsContainer.innerHTML = '';
            const errorEl = document.createElement('div');
            errorEl.style.cssText = 'color: red; text-align: center;';
            errorEl.textContent = `Error: ${error.message}`;
            statsContainer.appendChild(errorEl);
        }
        throw error;
    }
}

function resolveQualityValue(target) {
    if (target === undefined || target === null) return null;
    const raw = String(target).trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (lower === 'auto' || lower === 'abr' || lower === '-1') return 'auto';

    const tracks = (controlClient && Array.isArray(controlClient.tracks)) ? controlClient.tracks : [];
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && tracks.some((t) => Number(t.id) === numeric)) {
        return String(numeric);
    }

    const videos = tracks.filter((t) => t.type === 'video');
    let match = videos.find((t) => String(t.id) === raw);
    if (!match) match = videos.find((t) => String(t.label || '').toLowerCase() === lower);
    if (!match) {
        const resolution = lower.match(/(\d{3,4})\s*p?/);
        if (resolution) {
            const height = Number(resolution[1]);
            match = videos.find((t) => Number(t.height) === height);
        }
    }
    if (!match) match = videos.find((t) => t.height && lower.includes(`${t.height}p`));
    return match ? String(match.id) : null;
}

function apiSwitchQuality(target) {
    if (!controlClient || !Array.isArray(controlClient.tracks) || controlClient.tracks.length === 0) {
        pendingQualityTarget = target;
        return false;
    }
    const value = resolveQualityValue(target);
    if (value === null) return false;
    if (layerSelect) layerSelect.value = value;
    return applyLayerSelection(value);
}

function apiConnectP2P(enabled = true) {
    const on = enabled !== false;
    if (p2pCheckbox) p2pCheckbox.checked = on;
    if (on && sdkLastPlayOptions?.appId && sdkLastPlayOptions?.streamName) {
        clearP2PKnownUnavailable(sdkLastPlayOptions.appId, sdkLastPlayOptions.streamName);
    }
    if (sdkLastPlayOptions) {
        sdkLastPlayOptions = { ...sdkLastPlayOptions, p2p: on };
        if (reader || playbackRace || activePlaybackPath) {
            apiPlay(sdkLastPlayOptions).catch((error) => {
                console.warn('[Main] P2P switching failed:', error && error.message);
            });
        }
    } else if ((reader || playbackRace || activePlaybackPath) && p2pCheckbox &&
        typeof Event === 'function') {
        p2pCheckbox.dispatchEvent(new Event('change'));
    }
    return on;
}

function apiSetMediaPaused(kind, paused = true) {
    const wantPaused = paused !== false;
    if (controlClient) {
        controlClient.setMediaState({ [kind]: wantPaused ? 'paused' : 'resumed' });
        return wantPaused;
    }
    if (kind === 'video') {
        videoPaused = wantPaused;
        if (wantPaused) video.pause();
        else video.play().catch(() => {});
    } else {
        audioPaused = wantPaused;
        const stream = video.srcObject;
        if (stream && typeof stream.getAudioTracks === 'function') {
            stream.getAudioTracks().forEach((track) => { track.enabled = !wantPaused; });
        }
    }
    return wantPaused;
}

function apiMute(muted) {
    video.muted = muted !== false;
    updateMuteBtnLabel();
    return video.muted;
}

function apiStatistics(show) {
    if (!statsContainer) return false;
    statsContainer.classList.toggle('collapsed', show === false);
    return show !== false;
}

function apiGetTracks() {
    return (controlClient && Array.isArray(controlClient.tracks)) ? controlClient.tracks.slice() : [];
}

function apiGetState() {
    return {
        playing: !!(reader || playbackRace || activePlaybackPath),
        path: activePlaybackPathName || 'edge',
        videoPaused,
        audioPaused,
        muted: video.muted,
        recording: !!(mediaRecorder && mediaRecorder.state === 'recording'),
        quality: layerSelect ? layerSelect.value : null,
        p2p: preferP2P(),
        statisticsVisible: statsContainer ? !statsContainer.classList.contains('collapsed') : false,
        tracks: apiGetTracks(),
    };
}

if (typeof window !== 'undefined') {
    window.pplayer = Object.assign(window.pplayer || {}, {
        play: apiPlay,
        exit: () => {
            sdkLastPlayOptions = null;
            pendingQualityTarget = null;
            stopStream();
            return true;
        },
        switch_quality: apiSwitchQuality,
        connect_p2p: apiConnectP2P,
        pause_video: (paused = true) => apiSetMediaPaused('video', paused),
        pause_audio: (paused = true) => apiSetMediaPaused('audio', paused),
        mute: () => apiMute(true),
        unmute: () => apiMute(false),
        snapshot: captureSnapshot,
        record: toggleRecording,
        fullscreen: requestPlayerFullscreen,
        show_statistics: () => apiStatistics(true),
        hide_statistics: () => apiStatistics(false),
        get_tracks: apiGetTracks,
        get_state: apiGetState,
    });
}

// The page should just play on open: a signed link, a console ?url= preview,
// ?appId=&streamName=, or the Stream box's default (the console homepage links
// here with no params). A partial query string is surfaced as a link error
// instead.
(function autoStartFromQuery() {
    if (typeof window !== 'undefined' && window.__PPPLAYER_SDK__) return;
    prefillStreamInput();
    try {
        parsePlayRequest(window.location.search);
    } catch (error) {
        showLinkNotice(error.message);
        return;
    }
    if (new URLSearchParams(window.location.search).get('autoplay') !== '0') {
        startStream(false);
    }
})();


};

__modules["/ppplayer.mjs"] = function (module, exports, __require) {
// Polyfill for crypto.randomUUID on non-HTTPS origins
if (typeof crypto !== "undefined" && !crypto.randomUUID) {
    crypto.randomUUID = function() {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
        });
    };
}

// SELECT_LAYER reason that tells mmx this switch is the client carrying out
// its own ABR_RECOMMEND, not a user's manual pick - must match
// abrReasonAutoBandwidth in ppmmx's abr_ws_handler.go exactly, since the
// server keys off this string to decide whether to leave auto mode on.
const ABR_REASON_AUTO_BANDWIDTH = 'auto_bandwidth';

// jitteredDelay spreads out reconnect timing instead of using a fixed
// interval: if one Edge node drops at scale, every pplayer session attached
// to it hits its retry branch at roughly the same moment, and a fixed delay
// means they'd all retry again at the same moment too - a thundering herd
// that can hit the just-recovered Edge with a synchronized spike right when
// it's weakest. Returns a value in [baseMs, 2*baseMs), so a retry is never
// faster than before (baseMs was chosen for a reason) but is spread out
// across up to double that window.
function jitteredDelay(baseMs) {
  return baseMs + Math.random() * baseMs;
}

// ==========================================
// 1. MMX Control Client (WebSocket Protocol)
// ==========================================
class MMXControlClient {
    constructor(whepUrl, sessionId, callbacks) {
        this.sessionId = sessionId;
        this.callbacks = callbacks || {};
        this.ws = null;
        this.pingInterval = null;
        this.tracks = [];
        
        // [新增] 重连相关状态
        this.isIntentionalClose = false; // 是否是用户手动关闭
        this.reconnectTimer = null;
        this.reconnectDelay = 3000; // 3秒重连

        // 1. 解析 WHEP URL 以提取 host, protocol 和 path
        let pathName = '';
        let wsHost = '';
        let wsProtocol = 'ws:';
        let wsPort = '80';

        try {
            const urlObj = new URL(whepUrl);
            wsHost = urlObj.host;
            wsProtocol = urlObj.protocol === 'https:' ? 'wss:' : 'ws:';
            wsPort = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');

            const parts = urlObj.pathname.split('/');
            const whepIndex = parts.indexOf('whep');
            if (whepIndex > 0) {
                pathName = parts.slice(1, whepIndex).join('/');
            } else {
                // Should always find 'whep' in a real WHEP URL; if not,
                // don't silently substitute a placeholder path — surface it
                // so a misrouted WS control connection is obvious, not a
                // silent path=live/stream that never matches anything real.
                console.error(`[WS] '${whepUrl}' does not look like a WHEP URL (no 'whep' path segment)`);
            }
        } catch (e) {
            console.error('[WS] URL Parse Error:', e);
        }

        // 2. 构建 WebSocket URL（复用 WHEP HTTP 端口）
        const cleanHost = wsHost.split(':')[0];
        this.wsUrl = `${wsProtocol}//${cleanHost}:${wsPort}/ws/control?session_id=${sessionId}&path=${encodeURIComponent(pathName)}`;

        console.log(`[WS] Path: ${pathName}, URL: ${this.wsUrl}`);
        
        this.connect();
    }

    connect() {
        // 清除之前的重连定时器
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

        console.log(`[WS] Connecting...`);
        this.ws = new WebSocket(this.wsUrl);

        this.ws.onopen = () => {
            console.log('[WS] Connected');
            // 连接成功，重置主动关闭标志
            this.isIntentionalClose = false;
            
            if (this.callbacks.onConnected) this.callbacks.onConnected();
            this.startHeartbeat(); 
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                this.handleMessage(msg);
            } catch (e) {
                console.error('[WS] Processing error:', e);
            }
        };

        this.ws.onclose = (e) => {
            console.log(`[WS] Closed (Code: ${e.code}, Reason: ${e.reason})`);
            this.stopHeartbeat();
            
            if (this.callbacks.onDisconnected) this.callbacks.onDisconnected();

            // [核心修复] 自动重连逻辑（加抖动，避免 Edge 大规模掉线时所有客户端同时重连）
            if (!this.isIntentionalClose) {
                const delay = jitteredDelay(this.reconnectDelay);
                console.warn(`[WS] Connection lost unexpectedly. Retrying in ${Math.round(delay)}ms...`);
                this.reconnectTimer = setTimeout(() => {
                    this.connect();
                }, delay);
            }
        };

        this.ws.onerror = (err) => {
            // WS onerror 之后通常紧接着 onclose，重连逻辑在 onclose 处理
            console.error('[WS] Connection Error', err);
        };
    }

    handleMessage(msg) {
        if (!msg) return;
        const data = msg.data || msg.payload || {};

        switch (msg.type) {
            case 'TRACKS_INFO':
                let tracks = [];
                let activeId = null;

                if (Array.isArray(data)) {
                    tracks = data;
                } else if (data && Array.isArray(data.tracks)) {
                    tracks = data.tracks;
                    activeId = data.active_track_id;
                } else {
                    console.warn('[WS] Invalid TRACKS_INFO format:', msg);
                    return;
                }

                this.tracks = tracks;
                if (this.callbacks.onTracksInfo) {
                    this.callbacks.onTracksInfo(tracks, activeId);
                }
                break;

            case 'LAYER_SWITCHED':
                console.log(`[WS] Layer switched to Track ID: ${data.current_track_id}`);
                if (this.callbacks.onLayerSwitched) {
                    this.callbacks.onLayerSwitched(data.current_track_id);
                }
                break;

            case 'MEDIA_STATE':
                if (this.callbacks.onMediaState) this.callbacks.onMediaState(data);
                break;

            case 'OBS_TIMESTAMP':
                // The OBS absolute-timestamp mmx extracted from the publisher's
                // own bitstream SEI (see docs/obs-abs-timestamp-protocol.md in
                // the OBS repo) - works the same for RTMP/SRT/WHIP ingest since
                // SEI is embedded in the codec bitstream, not a protocol-specific
                // side channel. data: { timestamp }
                if (this.callbacks.onObsTimestamp) this.callbacks.onObsTimestamp(data);
                break;

            case 'ABR_MODE':
                // Who is currently driving layer selection. Sent on connect
                // and in reply to SET_ABR_MODE, so a reconnecting client
                // resyncs rather than assuming its own last known value.
                if (this.callbacks.onABRMode) this.callbacks.onABRMode(!!data.auto);
                break;

            case 'BANDWIDTH_ESTIMATE':
                // Server-side estimate of what this link will carry, in bits
                // per second (see abr_controller.go). Informational only -
                // the actual layer decision arrives separately as
                // ABR_RECOMMEND.
                if (this.callbacks.onBandwidthEstimate) {
                    this.callbacks.onBandwidthEstimate(data.bits_per_second || 0);
                }
                break;

            case 'ABR_RECOMMEND':
                // The server's suggested layer, computed from the bandwidth
                // estimate (see abr_controller.go). The server does not
                // switch anything itself - execution (calling selectLayer,
                // which is what actually asks mmx to switch) is this
                // client's job, so the same TrackSelector.Select code path
                // handles every switch, automatic or manual, and a user's
                // manual pick can never be silently overridden by a
                // concurrent server-side one.
                if (this.callbacks.onAbrRecommend) {
                    this.callbacks.onAbrRecommend(data.target_track_id);
                }
                break;

            case 'ERROR':
                const errMsg = data?.message || data?.error || 'Unknown Error';
                const errCode = data?.code || 'N/A';
                console.error(`[WS] Server Error: ${errMsg} (${errCode})`);
                break;

            case 'PONG':
                break;

            default:
                console.warn('[WS] Unknown message type:', msg.type);
        }
    }

    selectLayer(trackId, reason = 'manual') {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('[WS] Cannot switch layer: WebSocket not connected');
            return;
        }
        
        const msg = {
            msg_id: crypto.randomUUID(),
            type: 'SELECT_LAYER',
            timestamp: Math.floor(Date.now() / 1000),
            data: {
                target_track_id: parseInt(trackId),
                reason: reason 
            }
        };
        
        console.log(`[WS] Sending SELECT_LAYER id=${trackId} reason=${reason}`);
        this.ws.send(JSON.stringify(msg));
    }

    // Hands layer selection to the server (auto=true) or takes it back
    // (auto=false). Note that selectLayer() implies auto=false server-side,
    // so this only needs calling explicitly to return to automatic mode.
    setABRMode(auto) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('[WS] Cannot set ABR mode: WebSocket not connected');
            return false;
        }
        this.ws.send(JSON.stringify({
            msg_id: crypto.randomUUID(),
            type: 'SET_ABR_MODE',
            timestamp: Math.floor(Date.now() / 1000),
            data: { auto: !!auto }
        }));
        console.log(`[WS] Sending SET_ABR_MODE auto=${!!auto}`);
        return true;
    }

    setMediaState(state) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        this.ws.send(JSON.stringify({
            msg_id: crypto.randomUUID(),
            type: 'SET_MEDIA_STATE',
            timestamp: Math.floor(Date.now() / 1000),
            data: state
        }));
        return true;
    }

    sendLatencyReport(stats) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        
        const msg = {
            type: 'LATENCY_REPORT',
            timestamp: Math.floor(Date.now() / 1000),
            data: {
                rtt_ms: stats.rtt_ms || 0,
                jitter_buffer_ms: stats.jitter_buffer_ms || 0,
                packets_lost: stats.packets_lost || 0,
                // Per-kind split (see main.js's updateStats): audio is
                // forwarded as raw RTP end-to-end and has no NACK repair,
                // video is re-packetized and repaired on every hop, so only
                // the split tells upstream loss apart from last-hop loss.
                audio_packets_lost: stats.audio_packets_lost || 0,
                video_packets_lost: stats.video_packets_lost || 0,
                audio_loss_pct: stats.audio_loss_pct || 0,
                video_loss_pct: stats.video_loss_pct || 0,
                fps: stats.fps || 0,
                estimated_e2e_ms: stats.estimated_e2e_ms || 0
            }
        };
        this.ws.send(JSON.stringify(msg));
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'PING' }));
            }
        }, 30000);
    }

    stopHeartbeat() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    close() {
        // [新增] 标记为主动关闭，防止触发重连
        this.isIntentionalClose = true;
        
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.stopHeartbeat();
        
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// ==========================================
// 2. MediaMTX WebRTC Reader (WHEP)
// ==========================================
class MediaMTXWebRTCReader {
  constructor(conf) {
    this.retryPause = 2000;
    this.conf = conf;
    this.state = 'getting_codecs';
    this.restartTimeout = null;
    this.pc = null;
    this.offerData = null;
    this.sessionUrl = null;
    this.queuedCandidates = [];
    this.nonAdvertisedCodecs = [];
    this.#getNonAdvertisedCodecs();
  }

  get sessionId() {
      // Prefer session UUID from ID header (set during WHEP POST response)
      if (this._sessionUUID) return this._sessionUUID;
      // Fallback: extract from session URL tail (WHEP secret)
      if (!this.sessionUrl) return null;
      try {
          const urlParts = this.sessionUrl.split('/');
          return urlParts[urlParts.length - 1] || null;
      } catch (e) {
          return null;
      }
  }

  close() {
    const staleSessionUrl = this.sessionUrl;
    this.state = 'closed';
    if (this.pc !== null) {
      this.pc.close();
      this.pc = null;
    }
    if (this.restartTimeout !== null) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    this.sessionUrl = null;
    this.offerData = null;
    this.queuedCandidates = [];
    if (staleSessionUrl) {
      fetch(staleSessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
    }
  }

  static #limitBandwidth(sdp, bitrate) {
    if (!bitrate || parseInt(bitrate) <= 0) return sdp;
    const lines = sdp.split('\r\n');
    let videoIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('m=video')) {
        videoIndex = i;
        break;
      }
    }
    if (videoIndex !== -1) {
      lines.splice(videoIndex + 1, 0, `b=AS:${bitrate}`);
      console.log(`[SDP] Added bandwidth limit b=AS:${bitrate}`);
    }
    return lines.join('\r\n');
  }

  static #linkToIceServers(links) {
    return (links !== null) ? links.split(', ').map((link) => {
      const m = link.match(/^<(.+?)>; rel="ice-server"(; username="(.*?)"; credential="(.*?)"; credential-type="password")?/i);
      const ret = { urls: [m[1]] };
      if (m[3] !== undefined) {
        ret.username = JSON.parse(`"${m[3]}"`);
        ret.credential = JSON.parse(`"${m[4]}"`);
        ret.credentialType = 'password';
      }
      return ret;
    }) : [];
  }

  static #parseOffer(sdp) {
    const ret = { iceUfrag: '', icePwd: '', medias: [] };
    for (const line of sdp.split('\r\n')) {
      if (line.startsWith('m=')) {
        ret.medias.push(line.slice('m='.length));
      } else if (ret.iceUfrag === '' && line.startsWith('a=ice-ufrag:')) {
        ret.iceUfrag = line.slice('a=ice-ufrag:'.length);
      } else if (ret.icePwd === '' && line.startsWith('a=ice-pwd:')) {
        ret.icePwd = line.slice('a=ice-pwd:'.length);
      }
    }
    return ret;
  }

  static #generateSdpFragment(od, candidates) {
    let frag = `a=ice-ufrag:${od.iceUfrag}\r\n` + `a=ice-pwd:${od.icePwd}\r\n`;
    for (const candidate of candidates) {
      frag += `m=${od.medias[candidate.sdpMLineIndex]}\r\na=mid:${candidate.sdpMLineIndex}\r\na=${candidate.candidate}\r\n`;
    }
    return frag;
  }

  #handleError(err) {
    const httpStatus = (err && typeof err === 'object' && typeof err.httpStatus === 'number')
      ? err.httpStatus : undefined;
    const message = (err && typeof err === 'object' && err.message) ? err.message : String(err);
    if (this.state === 'running') {
      const staleSessionUrl = this.sessionUrl;
      if (this.pc !== null) {
        this.pc.close();
        this.pc = null;
      }
      this.offerData = null;
      this.sessionUrl = null;
      this.queuedCandidates = [];
      if (staleSessionUrl) {
        fetch(staleSessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
      }
      // Auth rejected (expired/invalid playback token): retrying this same URL
      // would just spin against a 401. Stop the internal loop and hand control
      // to the caller, which can re-mint a fresh token / re-resolve the play
      // decision and start a new reader. See main.js's onUnauthorized.
      if ((httpStatus === 401 || httpStatus === 403) && this.conf.onUnauthorized !== undefined) {
        this.state = 'failed';
        this.conf.onUnauthorized(message);
        return;
      }
      this.state = 'restarting';
      // Jittered, same reasoning as MMXControlClient's reconnect above: a
      // mass Edge disconnect must not make every reader retry in lockstep.
      this.restartTimeout = window.setTimeout(() => {
        this.restartTimeout = null;
        this.state = 'running';
        this.#start();
      }, jitteredDelay(this.retryPause));
      if (this.conf.onError !== undefined) {
        this.conf.onError(`${message}, retrying in some seconds`, httpStatus);
      }
    } else if (this.state === 'getting_codecs') {
      this.state = 'failed';
      if (this.conf.onError !== undefined) {
        this.conf.onError(message, httpStatus);
      }
    }
  }

  #getNonAdvertisedCodecs() {
    this.state = 'running';
    this.#start();
  }

  #start() {
    this.#requestICEServers()
      .then((iceServers) => this.#setupPeerConnection(iceServers))
      .then((offer) => this.#sendOffer(offer))
      .then((answer) => this.#setAnswer(answer))
      .then(() => {
          // close() only flips this.state; it can't cancel a promise chain
          // already in flight. Without this check, a stale reader whose
          // negotiation finishes *after* the user switched to a new URL
          // and started a new session would still fire onConnected here,
          // spinning up a control client for a session that's already
          // gone (and that nothing will ever clean up — an endless,
          // silently-failing WS reconnect loop against a dead session_id).
          if (this.state !== 'running') return;
          if (this.conf.onConnected) this.conf.onConnected();
      })
      .catch((err) => {
        console.error(err);
        this.#handleError(err);
      });
  }

  #authHeader() {
    if (this.conf.user) return {'Authorization': `Basic ${btoa(`${this.conf.user}:${this.conf.pass}`)}`};
    if (this.conf.token) return {'Authorization': `Bearer ${this.conf.token}`};
    return {};
  }

  #requestICEServers() {
    return fetch(this.conf.url, {
      method: 'OPTIONS',
      headers: { ...this.#authHeader() },
    }).then((res) => MediaMTXWebRTCReader.#linkToIceServers(res.headers.get('Link')));
  }

  #setupPeerConnection(iceServers) {
    if (this.state !== 'running') throw new Error('closed');

    this.pc = new RTCPeerConnection({
      iceServers,
      sdpSemantics: 'unified-plan',
      // Opt-in ONLY. Enabling encodedInsertableStreams makes Chrome route every
      // inbound encoded frame through a transform insertion point - and if the
      // caller never calls receiver.createEncodedStreams() and pumps
      // readable->writable, the frames are held there forever: they are
      // received and assembled but never reach the decoder, so framesDecoded
      // stays 0 and the <video> shows nothing (confirmed live 2026-09-24: the
      // race path enabled this but never consumed it, and manually pumping the
      // stream in the console immediately unfroze decode). So only turn it on
      // when a consumer WILL attach - i.e. the direct path, which reads the OBS
      // abs-timestamp SEI via sei-timestamp.mjs (attachSeiTimestampReader ->
      // createEncodedStreams). The race path leaves it off and decodes normally.
      encodedInsertableStreams: this.conf.insertableStreams === true,
    });

    const direction = 'recvonly';
    const videoTransceiver = this.pc.addTransceiver('video', { direction });
    this.pc.addTransceiver('audio', { direction });
    this.#preferVideoCodec(videoTransceiver);

    this.pc.onicecandidate = (evt) => this.#onLocalCandidate(evt);
    this.pc.onconnectionstatechange = () => this.#onConnectionState();
    this.pc.ontrack = (evt) => this.#onTrack(evt);

    return this.pc.createOffer()
      .then((offer) => {
        let sdp = offer.sdp;
        if (this.conf.maxBitrate) {
            sdp = MediaMTXWebRTCReader.#limitBandwidth(sdp, this.conf.maxBitrate);
        }
        const lines = sdp.split('\r\n').filter(l => 
          !l.toLowerCase().startsWith('a=rid:') && 
          !l.toLowerCase().startsWith('a=simulcast:')
        );
        sdp = lines.join('\r\n');

        this.offerData = MediaMTXWebRTCReader.#parseOffer(sdp);
        const modifiedOffer = new RTCSessionDescription({ type: 'offer', sdp: sdp });
        return this.pc.setLocalDescription(modifiedOffer).then(() => sdp);
      });
  }

  // Force the requested codec to lead the video offer. Without this a HEVC
  // path is rejected by mmx with "requires H265 video (offer m-lines:
  // audio:port=9,sendrecv)" because Chrome's default offer lists H264/VP8
  // only, even when H265 receive is available.
  #preferVideoCodec(transceiver) {
    const want = String(this.conf.videoCodec || '').toLowerCase();
    if (want !== 'h264' && want !== 'hevc') return;
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
    const caps = (typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities?.('video')) ||
      (typeof RTCRtpSender !== 'undefined' && RTCRtpSender.getCapabilities?.('video')) || null;
    const codecs = caps?.codecs || [];
    if (codecs.length === 0) return;
    const match = codecs.find((c) => want === 'hevc'
      ? /h265|hevc/i.test(c.mimeType)
      : /h264/i.test(c.mimeType));
    if (!match) return;
    try {
      transceiver.setCodecPreferences([match, ...codecs.filter((c) => c !== match)]);
    } catch {
      // Browser rejected the preference list; keep its default order.
    }
  }

  #sendOffer(offer) {
    if (this.state !== 'running') throw new Error('closed');
    return fetch(this.conf.url, {
      method: 'POST',
      headers: { ...this.#authHeader(), 'Content-Type': 'application/sdp' },
      body: offer,
    }).then((res) => {
      if (res.status !== 201) return res.text().then(body => {
        const err = new Error(`bad status code ${res.status}: ${body}`);
        err.httpStatus = res.status;
        throw err;
      });
      const location = res.headers.get('location');
      if (!location) throw new Error("Missing Location header in response");
      
      // Extract session UUID from ID header (for WS control channel)
      const sessionUUID = res.headers.get('id') || res.headers.get('ID');
      if (sessionUUID) {
        this._sessionUUID = sessionUUID;
        console.log(`[WHEP] Session UUID: ${sessionUUID}`);
      }
      
      this.sessionUrl = new URL(location, this.conf.url).toString();
      console.log(`[WHEP] Session URL: ${this.sessionUrl}`);
      
      if (this.queuedCandidates.length > 0) {
        this.#sendLocalCandidates(this.queuedCandidates);
        this.queuedCandidates = [];
      }
      return res.text();
    });
  }

  #setAnswer(answer) {
    if (this.state !== 'running') throw new Error('closed');
    return this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answer }));
  }

  #onLocalCandidate(evt) {
    if (this.state !== 'running') return;
    if (evt.candidate !== null) {
      if (this.sessionUrl === null) {
        this.queuedCandidates.push(evt.candidate);
      } else {
        this.#sendLocalCandidates([evt.candidate]);
      }
    }
  }

  #sendLocalCandidates(candidates) {
    fetch(this.sessionUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/trickle-ice-sdpfrag', 'If-Match': '*' },
      body: MediaMTXWebRTCReader.#generateSdpFragment(this.offerData, candidates),
    }).catch((err) => {
        console.warn("Candidate patch failed:", err);
    });
  }

  #onConnectionState() {
    if (this.state !== 'running') return;
    if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') {
      this.#handleError('peer connection closed');
    }
  }

  #onTrack(evt) {
    if (this.state !== 'running') return;
    if (this.conf.onTrack !== undefined) this.conf.onTrack(evt);
  }
}



exports["MMXControlClient"] = MMXControlClient;
exports["MediaMTXWebRTCReader"] = MediaMTXWebRTCReader;
exports["ABR_REASON_AUTO_BANDWIDTH"] = ABR_REASON_AUTO_BANDWIDTH;
exports["jitteredDelay"] = jitteredDelay;
};

__modules["/abr-engine.mjs"] = function (module, exports, __require) {

// Layer bookkeeping for the quality selector.
//
// This used to be a full ABR decision engine: it sampled getStats() every
// second and picked a layer from decoded FPS and received bitrate. Both
// judgements now live server-side, driven by the send-side bandwidth
// estimate GCC derives from TWCC feedback (see abr_controller.go in ppmmx),
// which measures the link rather than inferring it from what happened to
// arrive. Received bitrate could not tell congestion apart from a publisher
// whose own bitrate had dropped; FPS measured the local decoder, not the
// network, and is now reported in LATENCY_REPORT for statistics only.
//
// What remains here is the client's half of that arrangement: which layers
// exist, which one is playing, and whether the user has taken manual
// control. The server owns the choice while in auto mode and switches on
// its own; those switches arrive as LAYER_SWITCHED exactly like the ones
// this client asks for.
class ABREngine {
    constructor(callbacks) {
        this.callbacks = callbacks || {};

        this.isAutoMode = true;
        this.currentTrackId = null;
        // Layer the user asked for but the server hasn't confirmed yet (see
        // notifyManualSwitch). currentTrackId deliberately stays on the old
        // layer until LAYER_SWITCHED arrives, so this is what the quality
        // selector should display in the meantime.
        this.pendingTrackId = null;

        this.audioTrackId = null;
        this.videoTrackIds = [];
        this.trackRegistry = {};

        // Most recent server-side bandwidth estimate in bits per second, or
        // null before the first BANDWIDTH_ESTIMATE arrives. Display only.
        this.lastBandwidthEstimate = null;
    }

    // currentVideoWidth is used only to guess the starting layer when the
    // server hasn't told us which one is active.
    setTracks(tracks, activeId, currentVideoWidth = 0) {
        this.trackRegistry = {};
        this.videoTrackIds = [];
        this.audioTrackId = null;

        const videos = tracks.filter(t => t.type === 'video');
        tracks.forEach(t => { this.trackRegistry[t.id] = t; });

        // 视频流按码率升序排列 (Low -> High)
        this.videoTrackIds = [...videos]
            .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))
            .map(t => t.id);

        const audioT = tracks.find(t => t.type === 'audio');
        if (audioT) {
            this.audioTrackId = audioT.id;
        }

        // Note that setTracks runs on every TRACKS_INFO, not just the first:
        // mmx resends it whenever track metadata changes (e.g. once it parses
        // each layer's real SPS, see SetTrackDimensions in
        // track_selector.go). activeId is always the layer actually playing,
        // so adopting it here stays correct even mid manual switch - the
        // user's not-yet-confirmed pick lives in pendingTrackId instead.
        if (activeId !== undefined && activeId !== null) {
            this.currentTrackId = activeId;
        } else if (this.currentTrackId === null && this.videoTrackIds.length > 0) {

            let matchedId = null;
            // 尝试通过当前 video 标签的真实宽度来匹配 Track
            if (currentVideoWidth > 0) {
                // 考虑到横竖屏，宽高可能互换，这里匹配 width 或 height
                const match = videos.find(t => t.width === currentVideoWidth || t.height === currentVideoWidth);
                if (match) matchedId = match.id;
            }

            if (matchedId !== null) {
                this.currentTrackId = matchedId;
                console.log(`[ABR] Initial track detected by real resolution: ID ${this.currentTrackId}`);
            } else {
                // 兜底方案：取排序后数组的最后一个元素 (High)
                this.currentTrackId = this.videoTrackIds[this.videoTrackIds.length - 1];
                console.log(`[ABR] Initial track not provided, assuming Highest: ID ${this.currentTrackId}`);
            }
        }

        console.log(`[ABR] Tracks loaded. Video IDs (Low->High): ${this.videoTrackIds}, Audio ID: ${this.audioTrackId}`);
    }

    notifyManualSwitch(trackId) {
        this.isAutoMode = false;
        // Do NOT update currentTrackId here: it's still the *old* layer
        // until the server confirms the switch (onLayerSwitched ->
        // notifyLayerSwitched, once ppplayer.mjs gets a LAYER_SWITCHED
        // message back). Setting it eagerly to the target made every
        // manual switch's very next switchMediaTrack() call see
        // trackId === currentTrackId and treat it as a no-op "redundant"
        // switch, silently dropping the actual controlClient.selectLayer
        // call - manual quality selection never took effect.
        //
        // Record it as pending instead, so the UI can keep showing the
        // user's choice while the switch is in flight.
        this.pendingTrackId = trackId;
        console.log(`[ABR] Manual switch detected. Auto Mode OFF.`);
    }

    // The layer the selector should display: the user's pending pick if one
    // is outstanding, otherwise whatever is actually playing.
    selectedTrackId() {
        return (this.pendingTrackId !== null) ? this.pendingTrackId : this.currentTrackId;
    }

    notifyLayerSwitched(trackId) {
        this.currentTrackId = trackId;
        this.pendingTrackId = null;
    }

    // Reflects the server's view of who is driving selection (ABR_MODE).
    // Kept separate from setAutoMode so a server-sent state can't be
    // mistaken for a local request and echoed straight back.
    notifyAutoMode(enabled) {
        this.isAutoMode = enabled;
        if (enabled) this.pendingTrackId = null;
        console.log(`[ABR] Auto Mode (from server): ${enabled}`);
    }

    setAutoMode(enabled) {
        this.isAutoMode = enabled;
        // Going back to auto abandons any outstanding manual pick.
        if (enabled) this.pendingTrackId = null;
        console.log(`[ABR] Auto Mode: ${enabled}`);
    }

    notifyBandwidthEstimate(bitsPerSecond) {
        this.lastBandwidthEstimate = bitsPerSecond;
    }
}



exports["ABREngine"] = ABREngine;
};

__modules["/sei-timestamp.mjs"] = function (module, exports, __require) {

// Reads the OBS abs-timestamp SEI (see docs/obs-abs-timestamp-protocol.md
// in the OBS repo) directly out of the received H.264/H.265 bitstream via
// WebCodecs Insertable Streams (RTCRtpReceiver.createEncodedStreams()).
//
// Unlike the OBS_TIMESTAMP server relay (see obs-timestamp.mjs /
// obs_timestamp_broadcast.go), the SEI travels inside the encoded frame
// itself, so it survives mmx-to-mmx cascading (origin -> edge -> ...)
// without any server-side relay code: mmx's WHIP/WHEP path is pure RTP
// passthrough (UseRTPPackets: true end to end), and the ABR track
// selector's remuxer only strips SPS/PPS/AUD, never SEI. It's also
// inherently correct for whichever simulcast layer is currently being
// decoded - no rid matching needed, since these are the frames the browser
// is actually about to decode.
//
// HEVC/H264 multitrack (see
// docs/design/whip-hevc-h264-multitrack-simulcast-design.zh-CN.md): ppobs
// embeds the identical SEI payload in both codecs' bitstreams (see
// abs-ts.h in the OBS repo, which SEI-injects every packet_callback
// regardless of which WHIP session it belongs to), so only the NAL
// container format differs between the two - see findObsAbsTimestamp's
// `codec` parameter.
//
// Chromium-only (createEncodedStreams requires the PeerConnection to be
// constructed with { encodedInsertableStreams: true }, see mmxplayer.js);
// on browsers without it, attachSeiTimestampReader() is a no-op returning
// false, and the caller should keep relying on the OBS_TIMESTAMP server relay.

const OBS_ABS_TS_SEI_UUID = new Uint8Array([
    0x4F, 0x42, 0x53, 0x2D, 0x41, 0x42, 0x53, 0x54, // "OBS-ABST"
    0x53, 0x2D, 0x53, 0x45, 0x49, 0x2D, 0x76, 0x31, // "S-SEI-v1"
]);

function bytesEqualAt(data, offset, needle) {
    if (offset + needle.length > data.length) return false;
    for (let i = 0; i < needle.length; i++) {
        if (data[offset + i] !== needle[i]) return false;
    }
    return true;
}

// Removes H.264 emulation-prevention bytes (00 00 03 -> 00 00) from a NAL's
// raw bytes, needed before interpreting SEI payload type/size/content:
// escaping is part of RBSP encoding itself, independent of Annex-B framing.
function unescapeRBSP(nal) {
    const out = new Uint8Array(nal.length);
    let o = 0;
    let zeroRun = 0;
    for (let i = 0; i < nal.length; i++) {
        const b = nal[i];
        if (zeroRun >= 2 && b === 0x03 && i + 1 < nal.length && nal[i + 1] <= 0x03) {
            zeroRun = 0;
            continue; // drop emulation_prevention_three_byte
        }
        out[o++] = b;
        zeroRun = (b === 0) ? zeroRun + 1 : 0;
    }
    return out.subarray(0, o);
}

// Finds Annex-B start codes (00 00 01 / 00 00 00 01) in `data` and returns
// the byte range of each NAL (header + RBSP, excluding the start code).
function* iterateAnnexBNALs(data) {
    const len = data.length;
    let i = 0;
    let nalStart = -1;
    while (i + 2 < len) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
            if (nalStart >= 0) yield data.subarray(nalStart, i);
            nalStart = i + 3;
            i += 3;
            continue;
        }
        i++;
    }
    if (nalStart >= 0 && nalStart < len) yield data.subarray(nalStart, len);
}

// NAL unit type and header length for each codec's Annex-B framing. H.264's
// header is one byte (nal_unit_type in bits 0-4); H.265/HEVC's is two bytes
// (nal_unit_type in bits 1-6 of the first byte - see Rec. ITU-T H.265
// §7.3.1.2). Both codecs' SEI *message* syntax (payloadType/payloadSize/
// payload, Rec. ITU-T H.264|H.265 Annex D.1) is identical, so only NAL
// header parsing needs to branch.
const NAL_KIND_H264_SEI = 6;
const NAL_KIND_HEVC_SEI_PREFIX = 39;
const NAL_KIND_HEVC_SEI_SUFFIX = 40;

function parseNalHeader(codec, firstByte) {
    if (codec === 'hevc') {
        return { type: (firstByte >> 1) & 0x3F, headerLen: 2 };
    }
    return { type: firstByte & 0x1F, headerLen: 1 };
}

function isSeiNal(codec, nalType) {
    if (codec === 'hevc') return nalType === NAL_KIND_HEVC_SEI_PREFIX || nalType === NAL_KIND_HEVC_SEI_SUFFIX;
    return nalType === NAL_KIND_H264_SEI;
}

// Scans one encoded H.264/H.265 access unit for a user_data_unregistered
// SEI NAL (payload type 5) carrying the OBS abs-timestamp UUID, returning
// the embedded timestamp_ms (see protocol doc section 2), or null if
// absent. `codec` is 'h264' (default) or 'hevc' - see the NAL_KIND_*
// constants above for why the two need different header parsing.
function findObsAbsTimestamp(data, codec) {
    for (const rawNal of iterateAnnexBNALs(data)) {
        if (rawNal.length < 2) continue;
        // strip trailing zero-padding some encoders leave before the next start code
        let end = rawNal.length;
        while (end > 0 && rawNal[end - 1] === 0) end--;
        if (end < 2) continue;

        const { type: nalType, headerLen } = parseNalHeader(codec, rawNal[0]);
        if (!isSeiNal(codec, nalType)) continue;
        if (end <= headerLen) continue;

        const nal = unescapeRBSP(rawNal.subarray(0, end));
        let p = headerLen; // skip the codec's NAL header

        let payloadType = 0;
        while (p < nal.length && nal[p] === 0xFF) { payloadType += 255; p++; }
        if (p >= nal.length) continue;
        payloadType += nal[p]; p++;

        let payloadSize = 0;
        while (p < nal.length && nal[p] === 0xFF) { payloadSize += 255; p++; }
        if (p >= nal.length) continue;
        payloadSize += nal[p]; p++;

        if (payloadType !== 5 || payloadSize < 24 || p + 24 > nal.length) continue;
        if (!bytesEqualAt(nal, p, OBS_ABS_TS_SEI_UUID)) continue;

        let ts = 0;
        for (let k = 0; k < 8; k++) {
            ts = ts * 256 + nal[p + 16 + k];
        }
        return ts;
    }
    return null;
}

// Attaches an Insertable Streams passthrough transform to a video
// RTCRtpReceiver: every encoded frame is scanned for the OBS abs-timestamp
// SEI and, if found, reported via onTimestamp(timestampMs); frames are
// always forwarded unmodified. Returns false (no-op) if this browser
// doesn't support createEncodedStreams. `codec` is 'h264' (default) or
// 'hevc' - the caller knows which WHEP session (".../h264/whep" vs
// ".../hevc/whep") this receiver's track came from and must pass the
// matching value, since the two codecs' NAL framing differs (see
// findObsAbsTimestamp above).
function attachSeiTimestampReader(receiver, onTimestamp, codec) {
    if (!receiver || typeof receiver.createEncodedStreams !== 'function') return false;

    const resolvedCodec = codec === 'hevc' ? 'hevc' : 'h264';

    let streams;
    try {
        streams = receiver.createEncodedStreams();
    } catch (e) {
        console.warn('[SEI] createEncodedStreams failed:', e && e.message);
        return false;
    }

    const transform = new TransformStream({
        transform(frame, controller) {
            try {
                const ts = findObsAbsTimestamp(new Uint8Array(frame.data), resolvedCodec);
                if (ts !== null) onTimestamp(ts);
            } catch (e) {
                // A parse error must never break playback - just skip this frame.
            }
            controller.enqueue(frame);
        }
    });

    streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch((e) => {
        console.warn('[SEI] insertable-streams pipeline error:', e && e.message);
    });

    return true;
}

// Consumes and forwards an encoded-streams receiver without inspecting it.
// Chrome routes EVERY inbound encoded track through the insertion point as
// soon as the PeerConnection is built with { encodedInsertableStreams: true },
// not just the one receiver whose transform we create. If we only consume the
// video receiver (for the SEI reader above) and leave audio unconsumed, the
// audio frames are received and assembled but never released to the decoder:
// getStats() shows audio packets/bytes climbing with totalSamplesReceived 0
// and audioLevel 0, so the stream is audibly silent even after unmuting.
// Audio needs no parsing, so a passthrough transform is enough to unblock it.
function attachPassthroughTransform(receiver) {
    if (!receiver || typeof receiver.createEncodedStreams !== 'function') return false;

    let streams;
    try {
        streams = receiver.createEncodedStreams();
    } catch (e) {
        console.warn('[EncodedStreams] createEncodedStreams failed:', e && e.message);
        return false;
    }

    const transform = new TransformStream({
        transform(frame, controller) {
            controller.enqueue(frame);
        }
    });

    streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch((e) => {
        console.warn('[EncodedStreams] passthrough pipeline error:', e && e.message);
    });

    return true;
}



exports["attachSeiTimestampReader"] = attachSeiTimestampReader;
exports["attachPassthroughTransform"] = attachPassthroughTransform;
exports["findObsAbsTimestamp"] = findObsAbsTimestamp;
};

__modules["/codec-capability.mjs"] = function (module, exports, __require) {

// Browser HEVC playback capability detection - see
// docs/design/whip-hevc-h264-multitrack-simulcast-design.zh-CN.md §4.4.
//
// The result decides which of ppobs's two independent WHIP publish paths
// (".../h264/whep" or ".../hevc/whep") this player requests, so it must be
// resolved *before* the WHEP handshake starts - there's no ABR-style
// mid-stream codec switch, since the two codecs are on entirely separate
// WHIP/WHEP sessions server-side (see the design doc's §2.2).
//
// Detection is deliberately conservative: any failure, unsupported API, or
// inconclusive result falls back to H264, which every target browser can
// decode. HEVC is only selected when the browser affirmatively reports
// support.

// A single representative HEVC profile/level string is enough to answer
// "can this browser decode HEVC over WebRTC at all" - ppobs's HEVC
// Simulcast layers all share the same encoder/profile (see
// WHIPHevcEncoders.hpp in the ppobs repo), so per-resolution probing isn't
// needed here.
const HEVC_MEDIA_CAPABILITIES_CODEC = 'hvc1.1.6.L93.B0';
const HEVC_RTP_MIME_TYPES = ['video/H265', 'video/HEVC'];

// 1. navigator.mediaCapabilities.decodingInfo() - the standards-track API
// for "can this browser decode and smoothly play this codec". Asking for a
// WebRTC media type keeps the query aligned with how the frame will
// actually be delivered (over RTP, not a container demuxer).
async function hevcSupportedViaMediaCapabilities() {
    if (!navigator.mediaCapabilities || typeof navigator.mediaCapabilities.decodingInfo !== 'function') {
        return null; // API unavailable - caller tries the next method
    }
    try {
        const result = await navigator.mediaCapabilities.decodingInfo({
            type: 'webrtc',
            video: {
                contentType: `video/mp4; codecs="${HEVC_MEDIA_CAPABILITIES_CODEC}"`,
                width: 1920,
                height: 1080,
                bitrate: 3000000,
                framerate: 30,
            },
        });
        return !!(result && result.supported);
    } catch (e) {
        console.warn('[CodecCapability] mediaCapabilities.decodingInfo failed:', e && e.message);
        return null;
    }
}

// 2. RTCRtpReceiver.getCapabilities('video') - lists every codec the local
// WebRTC implementation can negotiate as a receiver, independent of the
// mediaCapabilities API's own (sometimes more conservative) judgment about
// "smooth" playback. Used as a fallback, per the design doc's suggested
// detection order.
function hevcSupportedViaRtpCapabilities() {
    if (typeof RTCRtpReceiver === 'undefined' || typeof RTCRtpReceiver.getCapabilities !== 'function') {
        return null;
    }
    try {
        const caps = RTCRtpReceiver.getCapabilities('video');
        if (!caps || !Array.isArray(caps.codecs)) return null;
        return caps.codecs.some((c) => HEVC_RTP_MIME_TYPES.includes(c.mimeType));
    } catch (e) {
        console.warn('[CodecCapability] RTCRtpReceiver.getCapabilities failed:', e && e.message);
        return null;
    }
}

// Cached across calls within a page load: capability doesn't change at
// runtime, and repeating the async mediaCapabilities probe on every
// (re)connect would just add latency to stream start for no benefit.
let cachedHevcSupport = null;

async function isHevcPlaybackSupported() {
    if (cachedHevcSupport !== null) return cachedHevcSupport;

    // Ask both probes and accept EITHER as a yes. The WebRTC
    // mediaCapabilities query is unreliable in Chrome - a
    // {type:'webrtc', contentType:'video/mp4; codecs="hvc1..."'} request can
    // answer supported:false even on a browser that negotiates and hardware-
    // decodes H265 over WebRTC - and treating that "false" as final (the old
    // behaviour, where RTCRtpReceiver was only consulted when
    // mediaCapabilities was *inconclusive*) is exactly what made HEVC
    // unplayable on a capable browser. RTCRtpReceiver.getCapabilities is the
    // authoritative signal for "this WebRTC stack offers H265", so it can
    // override a mediaCapabilities false; only when neither probe affirms
    // support do we fall back to the always-available H264.
    const viaMediaCapabilities = await hevcSupportedViaMediaCapabilities();
    const viaRtpCapabilities = hevcSupportedViaRtpCapabilities();
    cachedHevcSupport = viaMediaCapabilities === true || viaRtpCapabilities === true;
    console.log(`[CodecCapability] HEVC playback supported: ${cachedHevcSupport}` +
        ` (mediaCapabilities=${viaMediaCapabilities}, rtpCapabilities=${viaRtpCapabilities})`);
    return cachedHevcSupport;
}

// Public entry point matching the design doc's §4.4 sketch exactly.
async function selectPlaybackCodec() {
    return (await isHevcPlaybackSupported()) ? 'hevc' : 'h264';
}



exports["isHevcPlaybackSupported"] = isHevcPlaybackSupported;
exports["selectPlaybackCodec"] = selectPlaybackCodec;
};

__modules["/time-sync.mjs"] = function (module, exports, __require) {

// Application-layer NTP-style clock offset calibration against ppcenter's
// /ws/play endpoint (PLY-014 / CTR-020; see docs/tech/P2P?�延测�??��?.md).
//
// Why this exists: p2p delay is computed as `now - <timestamp ppobs embedded
// when it sent the frame>`. That subtraction is only meaningful if both
// clocks share a base. ppobs disciplines itself against public NTP servers
// (see ntp-clock.c in the OBS repo), but a browser can't do real NTP - no
// UDP 123 - so its raw Date.now() may sit anywhere relative to UTC. Feeding
// an uncorrected clock into that subtraction produces nonsense: negative
// delays when the local clock runs ahead, absurdly large ones when it lags.
//
// The fix is the four-timestamp algorithm NTP uses internally, run over an
// ordinary WebSocket against ppcenter (which does run a real NTP daemon):
//
//   T1 = local time when the probe was sent
//   T2 = ppcenter's time when it received the probe
//   T3 = ppcenter's time when it replied
//   T4 = local time when the reply arrived
//
//   offset = ((T2 - T1) + (T3 - T4)) / 2   ~= ppcenterClock - localClock
//   rtt    = (T4 - T1) - (T3 - T2)         // network only, minus server time
//
// Correcting the local reading means ADDING offset, not subtracting it. The
// sign is easy to invert by accident, so: if the local clock runs 100ms ahead
// of ppcenter, offset comes out as -100, and local + (-100) cancels it.
//
// The algorithm assumes the two network directions are roughly symmetric.
// That's the standard NTP/PTP premise - it won't give microsecond accuracy,
// but it's far more than enough to tell a 200ms delay from a 145-second
// clock artifact.

const DEFAULT_PPCENTER_URL = 'http://127.0.0.1:18000';
// 10 minutes: device clocks drift, so a single calibration at startup goes
// stale over a long broadcast, but the resync itself costs a burst of
// sampleCount WebSocket messages on an already-open connection (no new
// connection - the 30s server ping in ppcenter's play_hub.go already keeps
// this socket alive regardless of how rarely TIME_SYNC fires). At a typical
// uncorrected consumer clock's worst-case drift (~100ppm), 10 minutes is
// ~60ms of worst-case staleness - still small next to the 70-400ms
// latencies this measures, and far cheaper at scale than the previous 45s
// cadence. Keep in sync with ppobs's mirror (ppcenter-time-sync.cpp's
// RESYNC_INTERVAL_MS) and ntp-clock.c's NTP_PPCENTER_STALE_NS, which must
// stay larger than this or ppobs's offset looks stale before its own next
// resync and it falls back to public NTP more often than intended.
const DEFAULT_RESYNC_INTERVAL_MS = 600000;
const DEFAULT_SAMPLE_COUNT = 6;
const SAMPLE_SPACING_MS = 150;
const PROBE_TIMEOUT_MS = 5000;
const RECONNECT_DELAY_MS = 3000;

class TimeSync {
    constructor(options) {
        const opts = options || {};
        this.ppcenter = opts.ppcenter || DEFAULT_PPCENTER_URL;
        this.resyncIntervalMs = opts.resyncIntervalMs || DEFAULT_RESYNC_INTERVAL_MS;
        this.sampleCount = opts.sampleCount || DEFAULT_SAMPLE_COUNT;
        this.onStateChange = opts.onStateChange || null;
        // Injectable so tests can drive the socket deterministically; falls
        // back to the browser global in normal use.
        this.WebSocketImpl = opts.WebSocketImpl ||
            (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
        if (!this.WebSocketImpl) throw new Error('TimeSync requires a WebSocket implementation');

        this.ws = null;
        this.offsetMs = null;
        this.lastSyncAt = null;
        this.lastSyncRttMs = null;
        this.resyncTimer = null;
        this.reconnectTimer = null;
        this.pending = new Map(); // t1 -> { resolve, reject, timer }
        this.closed = false;
    }

    // Offset-corrected wall clock, or null when no calibration has succeeded
    // yet. Callers MUST treat null as "can't compute a delay yet" rather than
    // silently falling back to Date.now() - that fallback is exactly the bug
    // this class exists to prevent.
    now() {
        if (this.offsetMs === null) return null;
        return Date.now() + this.offsetMs;
    }

    isReady() {
        return this.offsetMs !== null;
    }

    start() {
        this.closed = false;
        return this._ensureConnected()
            .then(() => this.calibrate())
            .then((ok) => {
                this._scheduleResync();
                return ok;
            });
    }

    stop() {
        this.closed = true;
        if (this.resyncTimer) {
            clearTimeout(this.resyncTimer);
            this.resyncTimer = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.pending.forEach((p) => {
            clearTimeout(p.timer);
            p.reject(new Error('time sync stopped'));
        });
        this.pending.clear();
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            ws.onclose = null;
            try { ws.close(); } catch (e) { /* already closing */ }
        }
        this.offsetMs = null;
        this._notify();
    }

    _notify() {
        if (this.onStateChange) {
            this.onStateChange({
                ready: this.isReady(),
                offsetMs: this.offsetMs,
                rttMs: this.lastSyncRttMs,
                lastSyncAt: this.lastSyncAt,
            });
        }
    }

    _wsUrl() {
        const u = new URL('/ws/play', this.ppcenter);
        u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:';
        return u.toString();
    }

    _ensureConnected() {
        if (this.ws && this.ws.readyState === this.WebSocketImpl.OPEN) return Promise.resolve();
        if (this.closed) return Promise.reject(new Error('time sync stopped'));

        return new Promise((resolve, reject) => {
            let settled = false;
            let ws;
            try {
                ws = new this.WebSocketImpl(this._wsUrl());
            } catch (e) {
                reject(e);
                return;
            }
            this.ws = ws;

            ws.onopen = () => {
                settled = true;
                console.log('[TimeSync] connected to ppcenter');
                resolve();
            };
            ws.onmessage = (evt) => this._onMessage(evt);
            ws.onerror = () => {
                if (!settled) {
                    settled = true;
                    reject(new Error('time sync websocket error'));
                }
            };
            ws.onclose = () => {
                if (this.ws === ws) this.ws = null;
                if (!settled) {
                    settled = true;
                    reject(new Error('time sync websocket closed'));
                }
                this._scheduleReconnect();
            };
        });
    }

    // ppcenter may restart or the network may blip; keep trying so a long
    // playback session recovers its calibration instead of showing a stale
    // offset forever.
    _scheduleReconnect() {
        if (this.closed || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.closed) return;
            this._ensureConnected()
                .then(() => this.calibrate())
                .catch(() => { /* onclose schedules the next attempt */ });
        }, RECONNECT_DELAY_MS);
    }

    _scheduleResync() {
        if (this.closed) return;
        if (this.resyncTimer) clearTimeout(this.resyncTimer);
        this.resyncTimer = setTimeout(() => {
            this.calibrate()
                .catch(() => { /* keep the previous offset and retry next round */ })
                .then(() => this._scheduleResync());
        }, this.resyncIntervalMs);
    }

    _onMessage(evt) {
        let msg;
        try {
            msg = JSON.parse(evt.data);
        } catch (e) {
            return;
        }
        // /ws/play carries other message types (GET_WHEP_URL/PUB_PTS); ignore
        // everything that isn't our probe reply.
        if (!msg || msg.type !== 'TIME_SYNC_ACK') return;
        const pending = this.pending.get(msg.t1);
        if (!pending) return;
        this.pending.delete(msg.t1);
        clearTimeout(pending.timer);
        pending.resolve(msg);
    }

    _probeOnce() {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
                reject(new Error('time sync not connected'));
                return;
            }
            const t1 = Date.now();
            // Date.now() has ms resolution, so two probes in the same
            // millisecond would collide in the pending map keyed by t1.
            if (this.pending.has(t1)) {
                reject(new Error('duplicate probe timestamp'));
                return;
            }
            const timer = setTimeout(() => {
                this.pending.delete(t1);
                reject(new Error('time sync probe timed out'));
            }, PROBE_TIMEOUT_MS);

            this.pending.set(t1, {
                timer,
                reject,
                resolve: (msg) => {
                    const t4 = Date.now();
                    const offsetMs = ((msg.t2 - t1) + (msg.t3 - t4)) / 2;
                    const rttMs = (t4 - t1) - (msg.t3 - msg.t2);
                    resolve({ offsetMs, rttMs });
                },
            });

            try {
                this.ws.send(JSON.stringify({ type: 'TIME_SYNC', t1 }));
            } catch (e) {
                this.pending.delete(t1);
                clearTimeout(timer);
                reject(e);
            }
        });
    }

    // Takes sampleCount probes and keeps the one with the lowest RTT: a
    // shorter round trip means less queuing/jitter skewing the symmetry
    // assumption, so its offset is the most trustworthy. This is the standard
    // NTP/SNTP sample-selection approach. A failed probe isn't fatal; if every
    // probe fails we keep the previous offset rather than writing garbage, and
    // return false so the caller can decide whether to warn.
    calibrate() {
        return this._ensureConnected().then(() => {
            const samples = [];
            let chain = Promise.resolve();

            for (let i = 0; i < this.sampleCount; i++) {
                chain = chain
                    .then(() => this._probeOnce())
                    .then((s) => { samples.push(s); }, () => { /* try the next sample */ })
                    .then(() => new Promise((r) => setTimeout(r, SAMPLE_SPACING_MS)));
            }

            return chain.then(() => {
                if (samples.length === 0) {
                    console.warn('[TimeSync] calibration failed, keeping previous offset');
                    return false;
                }
                const best = samples.reduce((a, b) => (b.rttMs < a.rttMs ? b : a));
                this.offsetMs = best.offsetMs;
                this.lastSyncRttMs = best.rttMs;
                this.lastSyncAt = Date.now();
                console.log(
                    `[TimeSync] calibrated: offset=${best.offsetMs.toFixed(1)}ms ` +
                    `rtt=${best.rttMs.toFixed(1)}ms (${samples.length}/${this.sampleCount} samples)`);
                this._notify();
                return true;
            });
        });
    }

    // Fire-and-forget telemetry; drops the report when the socket isn't open
    // rather than buffering, since losing an occasional sample doesn't move a
    // P50/P95/P99 aggregate.
    reportLatency({ path, delayMs } = {}) {
        if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) return false;
        if (path !== 'edge' && path !== 'p2p') return false;
        if (!Number.isFinite(delayMs)) return false;
        this.ws.send(JSON.stringify({ type: 'LATENCY_REPORT', path, delayMs: Math.round(delayMs) }));
        return true;
    }
}



exports["TimeSync"] = TimeSync;
exports["DEFAULT_PPCENTER_URL"] = DEFAULT_PPCENTER_URL;
};

__modules["/play-request.mjs"] = function (module, exports, __require) {
function parsePlayRequest(search, randomUUID = () => crypto.randomUUID()) {
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
        codec: ['h264', 'hevc'].includes((params.get('codec') || '').trim().toLowerCase())
            ? (params.get('codec') || '').trim().toLowerCase()
            : '',
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

async function requestPlayDecision(config, { fetchImpl = fetch, signal, natProbeId, preferP2P = true } = {}) {
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
            ...(config.codec ? { codec: config.codec } : {}),
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
async function requestErtspPlayDecision(config, { fetchImpl = fetch, signal } = {}) {
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
const PLAY_REQUEST_MAX_ATTEMPTS = 6;
const PLAY_REQUEST_RETRY_DELAY_MS = 2000;

function isTransientPlayError(error) {
    if (!error) return false;
    if (error.status === 503) return true;
    if (error.code === 'no_edge_available' || error.code === 'no_healthy_edge') return true;
    // Older ppcenter bodies carry no status/code on the error - fall back to
    // the message text so the retry still engages.
    return /no healthy edge/i.test(error.message || '');
}

async function requestPlayDecisionWithRetry(config, {
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

exports["parsePlayRequest"] = parsePlayRequest;
exports["requestPlayDecision"] = requestPlayDecision;
exports["requestErtspPlayDecision"] = requestErtspPlayDecision;
exports["PLAY_REQUEST_MAX_ATTEMPTS"] = PLAY_REQUEST_MAX_ATTEMPTS;
exports["PLAY_REQUEST_RETRY_DELAY_MS"] = PLAY_REQUEST_RETRY_DELAY_MS;
exports["isTransientPlayError"] = isTransientPlayError;
exports["requestPlayDecisionWithRetry"] = requestPlayDecisionWithRetry;
};

__modules["/edge-url.mjs"] = function (module, exports, __require) {
// Builds the full WHEP URL for a ppcenter-issued edge stream base.
//
// ppcenter returns the edge stream base, e.g.
//   https://edge-1.edge.pp-cdn.org/{appId}/{streamName}?txTime=..&txSecret=..
// Its path is bare (no codec segment, no /whep) but its query DOES carry the
// txTime/txSecret signature the edge verifies. The client appends the codec it
// can actually decode (see codec-capability.mjs) and the WHEP resource, keeping
// the query intact:
//   .../{stream}/hevc/whep?txTime=..&txSecret=..  when HEVC is supported
//   .../{stream}/h264/whep?txTime=..&txSecret=..  otherwise
//
// Idempotent for a URL that already carries a codec or /whep segment, so it is
// safe regardless of which shape the server hands back.
function buildEdgeWhepUrl(edgeStreamUrl, codecType) {
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

exports["buildEdgeWhepUrl"] = buildEdgeWhepUrl;
};

__modules["/whep-url.mjs"] = function (module, exports, __require) {
// pplayer pulls streams over WHEP only. A stream is addressed either by a WHEP
// URL ("https://<edge>/{appId}/{streamName}[/{h264|hevc}]/whep") or, in the
// Stream box, by "appId/streamName". Other pull formats (HLS, FLV, RTMP, SRT,
// RTSP ...) are not played: say so instead of feeding them to the WHEP reader.

const WHEP_ONLY_MESSAGE =
    'pplayer only plays WHEP streams. Use a WHEP URL (ending in /whep) or enter appId/streamName; '
    + 'HLS, FLV, RTMP, SRT and other URLs are not supported.';

// True for an http(s) URL whose path is {appId}/{streamName}[/{codec}]/whep.
function isWhepUrl(raw) {
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
function looksLikeUrl(raw) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(raw || '').trim());
}

exports["WHEP_ONLY_MESSAGE"] = WHEP_ONLY_MESSAGE;
exports["isWhepUrl"] = isWhepUrl;
exports["looksLikeUrl"] = looksLikeUrl;
};

__modules["/play-decision-runner.mjs"] = function (module, exports, __require) {
const { PlaybackRaceController } = __require("/playback-race-controller.mjs");
const { EdgeWHEPPath, P2PPlaybackPath } = __require("/playback-paths.mjs");

function getEdgeStreamUrl(decision) {
    if (!decision?.edgeStreamUrl) {
        throw new Error('play decision does not include an edgeStreamUrl');
    }
    return decision.edgeStreamUrl;
}

function createPlaybackRace(decision, {
    onSelected,
    onFailed,
    onTelemetry,
    ReaderClass,
    WebSocketClass,
    PeerConnectionClass,
    bufferMs = null,
    enableVisibleTrial = true,
    ControllerClass = PlaybackRaceController,
} = {}) {
    if (decision?.mode !== 'p2p-connect' || !decision.p2p) {
        throw new Error('play decision is not a P2P decision');
    }

    // Both legs get the same buffer length so the viewer sees the latency they
    // asked for regardless of which path ends up on screen. Edge is the default
    // and is shown immediately; P2P is a background upgrade the controller only
    // switches to after verifying it decodes (see PlaybackRaceController). The
    // decision's raceWindowMs/connectTimeoutMs described the old symmetric race
    // and no longer apply - the controller uses its own edge-primary timings.
    const edgePath = new EdgeWHEPPath({ url: getEdgeStreamUrl(decision), ReaderClass, bufferMs });
    const p2pPath = new P2PPlaybackPath({ session: decision.p2p, WebSocketClass, PeerConnectionClass, bufferMs });
    const controller = new ControllerClass({
        edgePath,
        p2pPath,
        enableVisibleTrial,
        onSelected,
        onFailed,
        onTelemetry,
    });
    return { controller, edgePath, p2pPath };
}

// Builds the direct (non-raced) P2P leg. Under the "ppcenter decides, no
// client-side racing" rule, a p2p-connect decision means the API already
// judged this pair traversable AND the publisher has a free slot, so playback
// connects P2P alone; the edge URL rides along only as a sequential
// failure fallback.
function createDirectP2PPlayback(decision, {
    WebSocketClass,
    PeerConnectionClass,
    bufferMs = null,
    insertableStreams = false,
    onVideoReceiver = null,
} = {}) {
    if (decision?.mode !== 'p2p-connect' || !decision.p2p) {
        throw new Error('play decision is not a P2P decision');
    }
    return new P2PPlaybackPath({
        session: decision.p2p,
        WebSocketClass,
        PeerConnectionClass,
        bufferMs,
        insertableStreams,
        onVideoReceiver,
    });
}

function startPlaybackFromDecision(decision, { startDirectStream, startP2PPlayback }) {
    // p2pAvailable is ppcenter's explicit "a P2P leg can actually be served
    // right now" flag (traversable pair AND a publisher slot reserved). Trust
    // it over mode: an older ppcenter omits it (undefined), which keeps the
    // previous mode-only behaviour; an explicit false means skip the P2P
    // handshake window and go straight to edge.
    if (decision?.mode === 'p2p-connect' && decision.p2pAvailable !== false) {
        if (!startP2PPlayback) {
            throw new Error('p2p-connect decision requires startP2PPlayback');
        }
        startP2PPlayback(decision);
        return 'p2p-connect';
    }
    if (decision?.mode === 'edge-only' || decision?.p2pAvailable === false) {
        startDirectStream(getEdgeStreamUrl(decision));
        return 'edge-only';
    }
    throw new Error('unsupported play decision mode');
}

exports["getEdgeStreamUrl"] = getEdgeStreamUrl;
exports["createPlaybackRace"] = createPlaybackRace;
exports["createDirectP2PPlayback"] = createDirectP2PPlayback;
exports["startPlaybackFromDecision"] = startPlaybackFromDecision;
};

__modules["/playback-race-controller.mjs"] = function (module, exports, __require) {
const PATH_EDGE = 'edge';
const PATH_P2P = 'p2p';

const defaultClock = {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
};

// Edge-primary playback with a verified, non-disruptive P2P upgrade.
//
// Product rule (2026-09-24): P2P exists ONLY to save edge bandwidth and must
// never cost user experience - the viewer defaults to the edge node. So:
//   * Edge is shown the instant it connects. It is the guaranteed path and is
//     NEVER torn down until P2P has proven, on-screen, that it can decode.
//   * P2P runs in the background. It is detected as "delivering media" purely
//     from transport stats (inbound packetsReceived), which move even while the
//     track is off-screen - so a working P2P is found without disturbing edge.
//   * The trial also waits for edge to actually decode a frame, not merely
//     connect: until edge has put a picture up there is nothing to protect and
//     a lot to lose - the trial would blank the viewer's first seconds, and a
//     revert would drop edge back onto a decoder that has to re-acquire a
//     keyframe (production 2026-09-24).
//   * Only then is P2P put on-screen on trial, with edge kept alive; if P2P
//     decodes within a short window it is committed (edge dropped, bandwidth
//     saved), otherwise the visible element reverts to the still-live edge with
//     no gap. A symmetric-NAT viewer (whose P2P ICE never connects, so no
//     packets ever arrive) simply stays on edge and never notices.
//
// Why not decide P2P on framesDecoded directly, like a real race? Because
// Chrome only spins up the decode pipeline for an inbound track once it is
// attached to the on-screen <video> (confirmed in production 2026-09-24: an
// off-screen sink and a MediaStreamTrackProcessor both leave framesDecoded at
// 0). Decode can therefore only be verified after showing the stream, which is
// exactly what the trial does.
class PlaybackRaceController {
    constructor({
        edgePath,
        p2pPath,
        // How long P2P has to start delivering media before we give up on it
        // for this session and stay on edge. A symmetric-NAT viewer never
        // delivers, so this just bounds the wasted background attempt. Kept
        // generous: edge itself can take several seconds to connect and the
        // P2P signal WebSocket handshake can be slow, so a short window would
        // give up before P2P had a fair chance. Cleared as soon as P2P media
        // actually flows (see _p2pMediaFlowing).
        p2pConnectTimeoutMs = 15000,
        // After P2P is put on-screen on trial, how long to confirm it actually
        // decodes before reverting to edge.
        p2pVerifyMs = 2500,
        pollIntervalMs = 150,
        // When false, P2P still connects and is watched from transport stats,
        // but is NEVER put on the visible <video> on trial. Showing a P2P leg
        // that cannot decode blanks the viewer for p2pVerifyMs then reverts - a
        // visible flash for no gain - so the on-screen trial stays off until P2P
        // decode is proven end-to-end (re-enable with ?p2ptrial=1). Edge, which
        // is already decoding, just stays on screen.
        enableVisibleTrial = true,
        onSelected = () => {},
        onFailed = () => {},
        onTelemetry = () => {},
        clock = defaultClock,
    }) {
        if (!edgePath || !p2pPath) {
            throw new TypeError('edgePath and p2pPath are required');
        }
        this.edgePath = edgePath;
        this.p2pPath = p2pPath;
        this.p2pConnectTimeoutMs = p2pConnectTimeoutMs;
        this.p2pVerifyMs = p2pVerifyMs;
        this.pollIntervalMs = pollIntervalMs;
        this.enableVisibleTrial = enableVisibleTrial;
        this.onSelected = onSelected;
        this.onFailed = onFailed;
        this.onTelemetry = onTelemetry;
        this.clock = clock;

        // idle | connecting | playing_edge | p2p_trial | playing_p2p | failed | stopped
        this.state = 'idle';
        this.selectedPath = null;
        this.edgeState = { ready: false, decoding: false, failed: false };
        this.p2pState = { flowing: false, failed: false, done: false };
        this.failureReported = false;
        this._trialSuppressed = false;
        this._timers = new Set();
        this._cancelMediaPoll = null;
        this._cancelEdgeDecodePoll = null;
        this._cancelVerifyPoll = null;
        this._p2pDeadline = null;
        this._verifyDeadline = null;
    }

    start() {
        if (this.state !== 'idle') {
            throw new Error('playback controller can only be started once');
        }
        this.state = 'connecting';
        this._emit('start', { p2pConnectTimeoutMs: this.p2pConnectTimeoutMs, p2pVerifyMs: this.p2pVerifyMs });

        this._startPath(this.edgePath, {
            onReady: () => this._edgeReady(),
            onFailed: (error) => this._edgeFailed(error),
        });
        this._startPath(this.p2pPath, {
            onNegotiated: () => this._p2pNegotiated(),
            onFailed: (error) => this._p2pFailed(error),
        });

        this._p2pDeadline = this._setTimeout(() => {
            if (this.state === 'p2p_trial' || this.state === 'playing_p2p' || this.p2pState.done) return;
            this._emit('p2p_give_up', { reason: 'no_media_within_timeout' });
            this._abandonP2P();
        }, this.p2pConnectTimeoutMs);
    }

    stop(reason = 'player_stopped') {
        if (this.state === 'stopped') return;
        this._teardownPolls();
        this._clearTimers();
        this._stopEdge();
        this._stopP2P();
        this.state = 'stopped';
        this._emit('stopped', { reason });
    }

    getState() {
        return {
            state: this.state,
            selectedPath: this.selectedPath,
            edge: { ...this.edgeState },
            p2p: { ...this.p2pState },
        };
    }

    _startPath(path, callbacks) {
        try {
            Promise.resolve(path.start(callbacks)).catch((error) => callbacks.onFailed(error));
        } catch (error) {
            callbacks.onFailed(error);
        }
    }

    _edgeReady() {
        if (this._terminal() || this.edgeState.ready) return;
        this.edgeState.ready = true;
        // P2P only ever takes the screen after edge is already playing, so at
        // edge-ready time nothing else can hold it; guard regardless.
        if (this.selectedPath === null) {
            this.selectedPath = PATH_EDGE;
            this.state = 'playing_edge';
            this._emit('edge_playing');
            this.onSelected({ path: PATH_EDGE, previousPath: null, reason: 'edge_ready' });
        }
        // "Connected" is not "showing a picture": edge still has to receive a
        // keyframe before the first frame decodes, which is typically a few
        // hundred ms and can be a whole GOP. Handing the screen to the P2P
        // trial during that window means the viewer's first seconds are blank
        // no matter which leg wins - and if the trial then reverts, edge
        // re-attaches and has to wait for a keyframe all over again
        // (production 2026-09-24: P2P took the screen 180ms after edge
        // connected, and nothing had been displayed yet). So the upgrade waits
        // until edge itself has decoded on-screen; only then is there a picture
        // worth risking, and a revert lands on a leg that is already decoding.
        this._cancelEdgeDecodePoll = this._pollInbound(
            () => this.edgePath.pc,
            (report) => report.framesDecoded > 0,
            () => this._edgeDecoding(),
        );
    }

    _edgeDecoding() {
        if (this._terminal() || this.edgeState.decoding) return;
        this.edgeState.decoding = true;
        this._cancelEdgeDecodePoll?.();
        this._cancelEdgeDecodePoll = null;
        this._emit('edge_decoding');
        // P2P media may already be flowing (it connected first); now that edge
        // is on screen and decoding, it is a safe revert target.
        this._maybeUpgradeToP2P();
    }

    _p2pNegotiated() {
        if (this._terminal() || this.p2pState.done || this.p2pState.flowing || this._cancelMediaPoll) return;
        // Watch for real inbound media on the P2P peer without putting it
        // on-screen. packetsReceived advancing on a connected PC means media is
        // actually arriving (a symmetric-NAT viewer never gets here).
        this._cancelMediaPoll = this._pollInbound(
            () => this.p2pPath.pc,
            (report, pc) => report.packetsReceived > 0 &&
                (pc.connectionState === 'connected' || pc.connectionState === 'completed' || pc.connectionState === undefined),
            () => this._p2pMediaFlowing(),
        );
    }

    _p2pMediaFlowing() {
        if (this._terminal() || this.p2pState.done) return;
        this.p2pState.flowing = true;
        this._cancelMediaPoll?.();
        this._cancelMediaPoll = null;
        // Media is flowing, so the "no media within timeout" deadline no longer
        // applies. Clear it here so it cannot fire during the on-screen trial
        // and abandon a P2P leg that is actually working (edge can take several
        // seconds to connect, so the trial often begins right at the deadline).
        this._clearTimer(this._p2pDeadline);
        this._p2pDeadline = null;
        // Edge may not be playing yet (P2P delivered media first); the upgrade
        // waits until it is, so edge is always the revert target.
        this._maybeUpgradeToP2P();
    }

    _maybeUpgradeToP2P() {
        if (this._terminal() || this.p2pState.done) return;
        if (this.state !== 'playing_edge' || !this.p2pState.flowing) return;
        // Never take the screen away from an edge leg that has not put a
        // picture on it yet - see _edgeReady().
        if (!this.edgeState.decoding) return;
        // With the on-screen trial disabled, edge (already decoding) stays put
        // and P2P is never shown; report the settled outcome as edge, once.
        if (!this.enableVisibleTrial) {
            if (!this._trialSuppressed) {
                this._trialSuppressed = true;
                this._emit('p2p_trial_suppressed', { reason: 'visible_trial_disabled' });
            }
            return;
        }
        // Trial: show P2P but keep edge running, so a revert is an instant
        // re-attach of the still-live edge stream with no visible gap.
        this.state = 'p2p_trial';
        this._emit('p2p_trial');
        this.onSelected({ path: PATH_P2P, previousPath: PATH_EDGE, reason: 'p2p_media_flowing' });
        // Confirm P2P actually decodes on-screen within the window, else revert
        // to the still-live edge. The deadline is a single timer (not folded
        // into the poll) so a revert fires deterministically.
        this._verifyDeadline = this._setTimeout(() => this._revertToEdge('p2p_no_decode'), this.p2pVerifyMs);
        this._cancelVerifyPoll = this._pollInbound(
            () => this.p2pPath.pc,
            (report) => report.framesDecoded > 0,
            () => this._commitP2P(),
        );
    }

    _commitP2P() {
        if (this._terminal() || this.state !== 'p2p_trial') return;
        this._cancelVerifyPoll?.();
        this._cancelVerifyPoll = null;
        this._clearTimer(this._verifyDeadline);
        this._verifyDeadline = null;
        this._clearTimer(this._p2pDeadline);
        this._p2pDeadline = null;
        this.selectedPath = PATH_P2P;
        this.state = 'playing_p2p';
        this.p2pState.done = true;
        // P2P is proven on-screen; drop edge to actually save the bandwidth.
        this._stopEdge();
        this._emit('p2p_committed');
    }

    _revertToEdge(reason) {
        if (this._terminal() || this.state !== 'p2p_trial') return;
        this._cancelVerifyPoll?.();
        this._cancelVerifyPoll = null;
        this._clearTimer(this._verifyDeadline);
        this._verifyDeadline = null;
        this.p2pState.done = true;
        this.p2pState.failed = true;
        this.selectedPath = PATH_EDGE;
        this.state = 'playing_edge';
        this._emit('p2p_reverted', { reason });
        this.onSelected({ path: PATH_EDGE, previousPath: PATH_P2P, reason });
        this._stopP2P();
    }

    _abandonP2P() {
        if (this.p2pState.done) return;
        this.p2pState.done = true;
        this._cancelMediaPoll?.();
        this._cancelMediaPoll = null;
        this._stopP2P();
    }

    _edgeFailed(error) {
        if (this._terminal() || this.edgeState.failed) return;
        this.edgeState.failed = true;
        this._emit('edge_failed', { error: errMessage(error) });
        // Edge is irrelevant once P2P has committed. While P2P is mid-trial the
        // verify poll may still commit (or revert - which will then re-fail
        // here with edge already flagged). Otherwise edge was the guaranteed
        // path and it is gone: playback can no longer be promised.
        if (this.state === 'playing_p2p' || this.state === 'p2p_trial') return;
        this._fail(new Error('edge playback path is unavailable'));
    }

    _p2pFailed(error) {
        if (this._terminal()) return;
        // Committed P2P dropping mid-stream is the one case where edge is gone
        // (it was torn down to save bandwidth). Restart it - a brief edge
        // reconnect beats a dead stream, and never degrading playback is the
        // whole point of keeping edge as the default.
        if (this.state === 'playing_p2p') {
            this._emit('p2p_failed', { error: errMessage(error) });
            this._stopP2P();
            this._restartEdge('p2p_runtime_failure');
            return;
        }
        if (this.p2pState.done) return;
        this.p2pState.done = true;
        this.p2pState.failed = true;
        this._cancelMediaPoll?.();
        this._cancelMediaPoll = null;
        this._cancelVerifyPoll?.();
        this._cancelVerifyPoll = null;
        this._clearTimer(this._verifyDeadline);
        this._verifyDeadline = null;
        this._emit('p2p_failed', { error: errMessage(error) });
        // If P2P failed while on trial (on-screen), fall back to edge, which was
        // never stopped. Otherwise edge just keeps playing, untouched.
        if (this.state === 'p2p_trial') {
            this.selectedPath = PATH_EDGE;
            this.state = 'playing_edge';
            this.onSelected({ path: PATH_EDGE, previousPath: PATH_P2P, reason: 'p2p_failed' });
        }
        this._stopP2P();
    }

    // Bring edge back after a committed P2P dropped. P2P is already marked done
    // so the reconnected edge is not re-upgraded to the dead peer.
    _restartEdge(reason) {
        this.selectedPath = null;
        this.state = 'reconnecting_edge';
        this.edgeState = { ready: false, decoding: false, failed: false };
        this._clearTimer(this._p2pDeadline);
        this._p2pDeadline = null;
        this._emit('edge_restarting', { reason });
        this._startPath(this.edgePath, {
            onReady: () => this._edgeReady(),
            onFailed: (err) => this._edgeFailed(err),
        });
    }

    _fail(error) {
        if (this.failureReported) return;
        this.failureReported = true;
        this._teardownPolls();
        this._clearTimers();
        this.state = 'failed';
        this._emit('failed', { error: errMessage(error) });
        this.onFailed(error);
    }

    _terminal() {
        return this.state === 'stopped' || this.state === 'failed';
    }

    _stopEdge() { try { this.edgePath.stop?.(); } catch { /* best-effort */ } }
    _stopP2P() { try { this.p2pPath.stop?.(); } catch { /* best-effort */ } }

    _teardownPolls() {
        this._cancelMediaPoll?.();
        this._cancelMediaPoll = null;
        this._cancelEdgeDecodePoll?.();
        this._cancelEdgeDecodePoll = null;
        this._cancelVerifyPoll?.();
        this._cancelVerifyPoll = null;
    }

    _setTimeout(callback, delay) {
        const timer = this.clock.setTimeout(() => { this._timers.delete(timer); callback(); }, delay);
        this._timers.add(timer);
        return timer;
    }

    _clearTimer(timer) {
        if (timer == null) return;
        this.clock.clearTimeout(timer);
        this._timers.delete(timer);
    }

    _clearTimers() {
        for (const timer of this._timers) this.clock.clearTimeout(timer);
        this._timers.clear();
    }

    // Polls the given PC's inbound-rtp video report until `predicate` holds
    // (-> onMatch), then stops. Returns a canceller. Timeouts are handled by
    // the caller's own deadline timer, not here, so this stays a pure "wait
    // until true" and testing a revert only needs to fire that one timer.
    _pollInbound(getPc, predicate, onMatch) {
        let stopped = false;
        const tick = async () => {
            if (stopped || this._terminal()) return;
            const pc = getPc();
            let matched = false;
            if (pc && typeof pc.getStats === 'function') {
                const stats = await pc.getStats().catch(() => null);
                if (stats) {
                    for (const report of stats.values()) {
                        if (report.type === 'inbound-rtp' && report.kind === 'video' && predicate(report, pc)) {
                            matched = true;
                            break;
                        }
                    }
                }
            }
            if (stopped || this._terminal()) return;
            if (matched) { onMatch(); return; }
            this.clock.setTimeout(tick, this.pollIntervalMs);
        };
        tick();
        return () => { stopped = true; };
    }

    _emit(event, details = {}) {
        this.onTelemetry({ event, at: this.clock.now(), ...details });
    }
}

function errMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

exports["PlaybackRaceController"] = PlaybackRaceController;
};

__modules["/playback-paths.mjs"] = function (module, exports, __require) {
const { applyPlayoutBuffer } = __require("/buffer-config.mjs");
const { MediaMTXWebRTCReader } = __require("/ppplayer.mjs");
const { attachPassthroughTransform } = __require("/sei-timestamp.mjs");

function preferH264(transceiver) {
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
    const caps = (typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities?.('video')) ||
        (typeof RTCRtpSender !== 'undefined' && RTCRtpSender.getCapabilities?.('video')) || null;
    const codecs = (caps?.codecs || []).filter((codec) =>
        String(codec?.mimeType || '').toLowerCase().includes('h264'));
    if (codecs.length === 0) return;
    try { transceiver.setCodecPreferences(codecs); } catch { /* keep browser defaults */ }
}

// Verbose diagnostics (raw SDP dumps) are opt-in with ?debug so a normal
// viewer's console stays readable. Node (tests) has no location, so this
// evaluates false there.
const PP_DEBUG = typeof globalThis.location !== 'undefined' &&
    new URLSearchParams(globalThis.location.search).has('debug');

// Two playback legs for a p2p-connect decision, driven by
// PlaybackRaceController's edge-primary + verified-P2P-upgrade model:
//   * EdgeWHEPPath is the default. It reports `onReady` the moment its WHEP
//     session connects; the controller hands it straight to the on-screen
//     <video>, which is what drives its decode. No off-screen decode probing -
//     an off-screen sink does not decode in Chrome anyway (see the controller).
//   * P2PPlaybackPath is the background bandwidth optimization. It reports
//     `onNegotiated` once its media track lands; the controller then watches
//     its PeerConnection's transport stats (packetsReceived) to tell whether
//     media is actually arriving before ever putting it on screen.
// Both report `onFailed`; neither decides anything itself.

class EdgeWHEPPath {
    // ReaderClass stays injectable for the tests, but defaults to the imported
    // SDK reader - nothing assigns window.MediaMTXWebRTCReader since the move
    // to ES modules.
    constructor({ url, ReaderClass = MediaMTXWebRTCReader, bufferMs = null }) {
        this.url = url;
        this.ReaderClass = ReaderClass;
        this.bufferMs = bufferMs;
        this.reader = null;
        this.stream = null;
    }

    start({ onReady, onFailed }) {
        this.reader = new this.ReaderClass({
            url: this.url,
            maxBitrate: 2500,
            // Deliberately no insertableStreams: the race path does not read the
            // SEI, so it must NOT enable the encoded transform - enabling it
            // without consuming it freezes decode (framesDecoded stays 0, black
            // screen). See ppplayer.mjs's encodedInsertableStreams comment.
            onTrack: (event) => {
                this.stream = event.streams[0] || this.stream;
                // Receivers only exist once a track has arrived, so this is the
                // earliest point the buffer length can be set.
                if (this.bufferMs !== null) applyPlayoutBuffer(this.pc, this.bufferMs);
                console.log(`[P2P] edge onTrack: kind=${event.track?.kind} stream=${Boolean(this.stream)}`);
            },
            onConnected: () => {
                // Edge is the guaranteed default path: as soon as it connects it
                // is handed to the on-screen <video> (the controller's
                // onSelected), which is what actually drives decode.
                console.log('[P2P] edge connected - handing to the visible player');
                onReady?.({ stream: this.stream });
            },
            onError: onFailed,
        });
    }

    // Retained as a no-op so main.js's onSelected can call it unconditionally
    // across an edge<->P2P switch. There is no longer any off-screen decode
    // sink to release (edge decodes on the visible element).
    releaseDecodeSink() {}

    stop() {
        this.reader?.close();
        this.reader = null;
    }

    get pc() { return this.reader?.pc || null; }
    get sessionId() { return this.reader?.sessionId || null; }
}

class P2PPlaybackPath {
    constructor({ session, WebSocketClass = globalThis.WebSocket, PeerConnectionClass = globalThis.RTCPeerConnection, bufferMs = null, insertableStreams = false, onVideoReceiver = null }) {
        this.session = session;
        this.WebSocketClass = WebSocketClass;
        this.PeerConnectionClass = PeerConnectionClass;
        this.bufferMs = bufferMs;
        // Opt-in encoded transform. The P2P leg carries the same OBS
        // abs-timestamp SEI the edge path reads: ppobs stamps it into every
        // encoded packet before obs-webrtc's Data() forwards packet->data
        // verbatim, so enabling this and letting onVideoReceiver consume it
        // turns the displayed P2P Delay from an RTT/jitter estimate into a
        // real measurement. Enabling it WITHOUT a consumer freezes decode, so
        // the caller must pass onVideoReceiver whenever this is true - see
        // ppplayer.mjs's encodedInsertableStreams comment.
        this.insertableStreams = insertableStreams;
        this.onVideoReceiver = onVideoReceiver;
        this.ws = null;
        this.pc = null;
        this.stream = null;
        this.onNegotiated = null;
        this.onFailed = null;
        this.onSignal = null;
        this.negotiated = false;
        this.pendingCandidates = [];
        this.stopped = false;
        this.seq = 0;
    }

    start({ onNegotiated, onFailed, onSignal }) {
        this.onNegotiated = onNegotiated;
        this.onFailed = onFailed;
        this.onSignal = onSignal;
        this.onSignal?.({ type: 'ws-connecting', url: this.session.signalUrl });
        this.ws = new this.WebSocketClass(this.session.signalUrl, [
            'ppcdn-p2p-v1', `ppcdn-token.${this.session.token}`,
        ]);
        this.ws.onopen = () => this.onSignal?.({ type: 'ws-open' });
        this.ws.onmessage = (event) => this.#onSignal(JSON.parse(event.data));
        this.ws.onerror = () => this.#fail(new Error('P2P signaling failed'));
        this.ws.onclose = () => { if (!this.stopped) this.#fail(new Error('P2P signaling closed')); };
    }

    async #onSignal(message) {
        if (this.stopped) return;
        // Every inbound signaling message is forwarded to onSignal (as-is) so
        // the caller can log/trace the handshake; the method only acts on the
        // ones that drive negotiation.
        this.onSignal?.(message);
        if (message.type === 'ready') {
            await this.#createOffer();
        } else if (message.type === 'answer' && message.sessionId === this.session.sessionId) {
            // TEMPORARY (2026-09-30): dump the P2P answer SDP for the
            // "connects but 0 frames" diagnosis - remove once understood.
            if (PP_DEBUG) console.log('[P2P-SDP] remote answer:\n' + message.sdp);
            await this.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
            this.onSignal?.({ type: 'remote-description-set' });
            for (const candidate of this.pendingCandidates) await this.pc.addIceCandidate(candidate);
            this.pendingCandidates = [];
        } else if (message.type === 'ice' && message.sessionId === this.session.sessionId) {
            if (this.pc.remoteDescription) await this.pc.addIceCandidate(message.candidate);
            else this.pendingCandidates.push(message.candidate);
        } else if (message.type === 'error') {
            this.#fail(new Error(message.reason || 'P2P signaling rejected'));
        }
    }

    async #createOffer() {
        const iceConfig = this.#iceServersConfig();
        // Keep passing `undefined` when there is neither a STUN config nor an
        // encoded transform, so the default PeerConnection dictionary is used
        // (and the existing "no config" contract holds).
        const pcConfig = this.insertableStreams
            ? { ...(iceConfig || {}), encodedInsertableStreams: true }
            : iceConfig;
        this.pc = new this.PeerConnectionClass(pcConfig);
        this.onSignal?.({ type: 'pc-created', iceServers: (iceConfig?.iceServers ?? []).map((s) => s.urls) });
        const videoTransceiver = this.pc.addTransceiver('video', { direction: 'recvonly' });
        preferH264(videoTransceiver);
        this.pc.addTransceiver('audio', { direction: 'recvonly' });
        this.pc.ontrack = (event) => {
            // The publisher (libdatachannel) may negotiate the track without a
            // media-level msid and emit only the SSRC-level msid, so some
            // browsers surface an empty event.streams and `event.streams[0]`
            // is undefined. Attaching that to <video> leaves it permanently
            // black with no error, so fall back to a MediaStream built from
            // the track (absorbed from p2player's p2p-path.mjs).
            if (event.streams[0]) {
                this.stream = event.streams[0];
            } else if (event.track && typeof globalThis.MediaStream === 'function') {
                if (!this.stream) this.stream = new globalThis.MediaStream();
                if (!this.stream.getTracks().includes(event.track)) {
                    this.stream.addTrack(event.track);
                }
            }
            this.onSignal?.({ type: 'track', kind: event.track?.kind, streamId: event.streams[0]?.id || null });
            // Hand the video receiver to the caller so it can attach the
            // encoded-streams consumer (the OBS abs-timestamp SEI reader) that
            // insertableStreams requires - see ppplayer.mjs.
            if (event.track?.kind === 'video' && event.receiver) {
                this.onVideoReceiver?.(event.receiver);
            }
            // Same encodedInsertableStreams requirement as the edge path: the
            // P2P PC enables it for the video SEI reader, which also holds the
            // audio receiver until its encoded stream is consumed. Pump it
            // through unchanged so the decoder gets the Opus frames.
            if (event.track?.kind === 'audio' && event.receiver && this.insertableStreams) {
                if (attachPassthroughTransform(event.receiver)) {
                    console.log('[EncodedStreams] P2P audio passthrough attached');
                }
            }
            // Same as the Edge path: receivers exist only once a track lands.
            if (this.bufferMs !== null) applyPlayoutBuffer(this.pc, this.bufferMs);
            // The PeerConnection and stream now exist; hand off to the
            // controller, which watches transport stats before deciding whether
            // this leg is worth putting on screen. Fire once.
            if (!this.negotiated) {
                this.negotiated = true;
                this.onNegotiated?.({ stream: this.stream });
            }
        };
        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.onSignal?.({ type: 'local-candidate', candidate: event.candidate.candidate });
                this.#send({ type: 'ice', candidate: event.candidate.toJSON() });
            } else {
                this.onSignal?.({ type: 'local-candidate', candidate: null });
            }
        };
        this.pc.oniceconnectionstatechange = () => this.onSignal?.({ type: 'iceconnectionstate', value: this.pc.iceConnectionState });
        this.pc.onicegatheringstatechange = () => this.onSignal?.({ type: 'icegatheringstate', value: this.pc.iceGatheringState });
        this.pc.onsignalingstatechange = () => this.onSignal?.({ type: 'signalingstate', value: this.pc.signalingState });
        this.pc.onconnectionstatechange = () => {
            this.onSignal?.({ type: 'connectionstate', value: this.pc.connectionState });
            if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') this.#fail(new Error('P2P connection failed'));
        };
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        // TEMPORARY (2026-09-30): dump the P2P offer SDP for the
        // "connects but 0 frames" diagnosis - remove once understood.
        if (PP_DEBUG) console.log('[P2P-SDP] local offer:\n' + offer.sdp);
        this.onSignal?.({ type: 'offer-created', sdpLength: offer.sdp?.length ?? 0 });
        this.#send({ type: 'offer', sdp: offer.sdp });
    }

    // ppcenter's own STUN address (models.STUNConfig.URLs() server-side) rides
    // in on session.stunServers, the same play-decision response everything
    // else here comes from. Without it this PeerConnection can only gather
    // `host` ICE candidates and never learns its own public-facing address -
    // P2P is then structurally unable to connect for any viewer not on the
    // publisher's LAN, regardless of NAT type. Filtered the same way ppobs's
    // C++ client filters this field: stun:/stuns: only, anything else silently
    // dropped rather than handed to the browser and rejected at PeerConnection
    // construction time.
    #iceServersConfig() {
        const stunUrls = (this.session.stunServers ?? []).filter(
            (url) => typeof url === 'string' && (url.startsWith('stun:') || url.startsWith('stuns:')));
        return stunUrls.length ? { iceServers: stunUrls.map((urls) => ({ urls })) } : undefined;
    }

    #send(message) {
        this.seq += 1;
        this.ws.send(JSON.stringify({ v: 1, seq: this.seq, sentAt: Date.now(), sessionId: this.session.sessionId, ...message }));
    }

    #fail(error) {
        if (!this.stopped) this.onFailed?.(error);
    }

    // No-op, mirroring EdgeWHEPPath (see there) - kept for main.js onSelected.
    releaseDecodeSink() {}

    stop(reason = 'stopped') {
        if (this.stopped) return;
        this.stopped = true;
        if (this.ws?.readyState === this.WebSocketClass.OPEN) this.#send({ type: 'close', reason });
        this.ws?.close();
        this.pc?.close();
    }
}

exports["EdgeWHEPPath"] = EdgeWHEPPath;
exports["P2PPlaybackPath"] = P2PPlaybackPath;
};

__modules["/buffer-config.mjs"] = function (module, exports, __require) {
// Playout buffer length is a purely local playback-side knob: it tells the
// browser's jitter buffer how many milliseconds of media to hold before
// rendering, trading latency for resilience to network jitter. ppcenter is
// not involved — there's nothing to negotiate, so this never goes into the
// /v1/play/requests body, only into the RTCRtpReceiver once a track exists
// (see playback-paths.mjs).
const MIN_BUFFER_MS = 50;
const MAX_BUFFER_MS = 1000;

// The playout buffer applied when no ?bufferMs= override is given. There is no
// longer a UI control for this - main.js always applies it (which pins the
// browser's own jitter buffer to a fixed length, for every receiver, audio
// included) unless a deployment overrides it via the query parameter.
const DEFAULT_BUFFER_MS = 50;

// parseBufferMs reads the raw "bufferMs" query value and clamps it into the
// supported [50, 1000] range. Missing/invalid input returns null rather than
// silently substituting a guessed default — callers that care about "was a
// buffer length requested at all" (e.g. deciding whether to touch
// playoutDelayHint and override the browser's own adaptive default) need to
// tell that apart from "requested 50 and got clamped to 50".
function parseBufferMs(rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') return null;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return null;
    return clampBufferMs(parsed);
}

function clampBufferMs(ms) {
    return Math.min(MAX_BUFFER_MS, Math.max(MIN_BUFFER_MS, ms));
}

// playoutDelayHint (RTCRtpReceiver) is expressed in seconds, not ms.
function bufferMsToPlayoutDelaySeconds(bufferMs) {
    return bufferMs / 1000;
}

// applyPlayoutBuffer pushes bufferMs onto every receiver on pc and reports
// which API actually accepted it, so a caller can tell "applied" apart from
// "this browser ignores the knob entirely" instead of assuming it worked.
//
// Two APIs exist, tried in this order:
//   - jitterBufferTarget: the standardized one (WebRTC Extensions), in ms.
//   - playoutDelayHint: Chrome's older non-standard property, in seconds.
// Chromium-based browsers support at least one; browsers that expose
// neither keep their own adaptive buffer and this returns null. Returns
// null too when pc has no receivers yet - tracks arrive asynchronously, so
// callers apply this on the track event rather than right after connecting -
// and when bufferMs is null/undefined, i.e. no length was requested: that is
// "leave the browser's adaptive buffer alone", and must not be confused with
// clampBufferMs's floor of 50.
function applyPlayoutBuffer(pc, bufferMs) {
    if (!pc || typeof pc.getReceivers !== 'function') return null;
    if (bufferMs === null || bufferMs === undefined) return null;
    const clamped = clampBufferMs(bufferMs);
    let usedStandard = false;
    let usedLegacy = false;
    for (const receiver of pc.getReceivers()) {
        if (!receiver) continue;
        if ('jitterBufferTarget' in receiver) {
            receiver.jitterBufferTarget = clamped;
            usedStandard = true;
        } else if ('playoutDelayHint' in receiver) {
            receiver.playoutDelayHint = bufferMsToPlayoutDelaySeconds(clamped);
            usedLegacy = true;
        }
    }
    if (usedStandard) return 'jitterBufferTarget';
    if (usedLegacy) return 'playoutDelayHint';
    return null;
}

exports["MIN_BUFFER_MS"] = MIN_BUFFER_MS;
exports["MAX_BUFFER_MS"] = MAX_BUFFER_MS;
exports["DEFAULT_BUFFER_MS"] = DEFAULT_BUFFER_MS;
exports["parseBufferMs"] = parseBufferMs;
exports["clampBufferMs"] = clampBufferMs;
exports["bufferMsToPlayoutDelaySeconds"] = bufferMsToPlayoutDelaySeconds;
exports["applyPlayoutBuffer"] = applyPlayoutBuffer;
};

__modules["/nat-probe.mjs"] = function (module, exports, __require) {
// pplayer's STUN server is stun.pp-cdn.org:3478 - a DNS-only record that
// points straight at ppcenter's own STUN server (internal/stun), so it is
// directly dialable over UDP. Deliberately a fixed host, NOT derived from the
// `ppcenter` URL: that host (api.pp-cdn.org) is Cloudflare-fronted and
// Cloudflare does not forward UDP/3478, so a derived stun:api.pp-cdn.org:3478
// never answers (confirmed in production from mainland China, 2026-11-07).
//
// Google's public STUN is raced alongside it as a reachability fallback: some
// networks can't reach ppcenter's own STUN at all (confirmed in production
// 2026-09-22 - a publisher's network that reached Google's STUN reliably
// every 4 minutes via ppobs's probe refresh got zero responses from
// ppcenter's own the moment Google was removed as a fallback), and a failed
// probe here means the whole attempt falls back to edge-only, so reachability
// matters more than which server answers.
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
function deriveStunIceServers() {
    return [
        { urls: 'stun:stun.pp-cdn.org:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
    ];
}

// Local half of the probe: gather ICE candidates against ppcdn's STUN and
// pick the best one. Needs no token and sends nothing, so the caller can start
// it as early as possible - in parallel with minting a viewer token or
// requesting the play decision - and submit only once the token is in hand
// (see submitNatProbe). Returns null when no usable (non-mDNS) candidate is
// found.
async function gatherNatProbe() {
    const pc = new RTCPeerConnection({
        iceServers: deriveStunIceServers(),
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
    return {
        natType: chosen.type === 'srflx' ? 'restricted' : 'public',
        publicIp: chosen.ip,
        publicPort: chosen.port,
        // The client's public IPv4 (empty for IPv6) so the caller can include
        // it in its pull-stream report without re-deriving it from the
        // candidate.
        ipv4: /^\d{1,3}(\.\d{1,3}){3}$/.test(chosen.ip || '') ? chosen.ip : '',
    };
}

// Remote half of the probe: report a gathered candidate to ppcenter and return
// its probe handle. Needs the viewer token for the Authorization header, so it
// runs after the token is available (gatherNatProbe itself does not). Returns
// null when there was nothing usable to report or the submission failed.
async function submitNatProbe({ ppcenter, appId, txTime, txSecret, clientId, streamName, kind, gathered }) {
    if (!gathered) return null;

    const body = {
        // kind is explicit: the viewer's probe is a "player" observation even
        // though it still carries streamName, which ppcenter needs only to
        // verify the viewer token (the token is signed over appId/streamName).
        kind: kind || (streamName ? 'publisher' : 'player'),
        clientId,
        natType: gathered.natType,
        publicIp: gathered.publicIp,
        publicPort: gathered.publicPort,
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
        // Carry the client's public IPv4 alongside the ppcenter response
        // fields (probeId etc.) so existing callers are unaffected.
        return Object.assign({}, data, { ipv4: gathered.ipv4 });
    } catch {
        return null;
    }
}

// Convenience wrapper preserving the original one-call shape (gather, then
// submit). Kept for callers that don't need to overlap the two halves.
async function probeNATAndSubmit(opts) {
    const gathered = await gatherNatProbe();
    return submitNatProbe({ ...opts, gathered });
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

exports["gatherNatProbe"] = gatherNatProbe;
exports["submitNatProbe"] = submitNatProbe;
exports["probeNATAndSubmit"] = probeNATAndSubmit;
};

__modules["/obs-timestamp.mjs"] = function (module, exports, __require) {
// PLY-013: consume the absolute timestamp ppobs embeds per frame and turn it
// into an end-to-end delay, using the PLY-014-calibrated clock from
// time-sync.mjs instead of raw Date.now(). ppobs embeds the timestamp
// directly in the codec bitstream as a SEI (H.264/H.265) / metadata OBU
// (AV1) payload (ppobs/docs/obs-abs-timestamp-protocol.md §2) - this works
// uniformly across RTMP/ERTMP, SRT, and WHIP ingest since it's part of the
// bitstream itself, not a protocol-specific side channel.
//
// mmx extracts that SEI/OBU on whichever protocol the publisher used (see
// internal/servers/webrtc/sei_timestamp.go for WHIP, internal/protocols/rtmp
// and internal/protocols/mpegts's to_stream.go for RTMP/SRT) and
// re-broadcasts it to WHEP readers as a `{"type":"OBS_TIMESTAMP",
// "data":{"timestamp":<ms>}}` envelope over the same ABR control WebSocket
// ppplayer's MMXControlClient already opens (ppplayer.mjs), not a new
// channel. isValidObsTimestampMessage validates the already-JSON.parsed
// `data` object regardless of which ingest protocol produced it.
//
// Scope note: this only ever fires for the edge path today (SEI read via
// WebCodecs Insertable Streams - see sei-timestamp.js - covers the direct
// P2P PeerConnection case for Chromium browsers instead); the P2P path for
// other browsers relies on RTCP RTT (see docs/tech/P2P时延测量方案.md §4).

function isValidObsTimestampMessage(msg) {
    return !!msg
        && typeof msg === 'object'
        && Number.isFinite(msg.timestamp)
        && msg.timestamp > 0;
}

// nowMs must already be offset-corrected (TimeSync#now()); passing the
// raw/uncorrected clock defeats the entire point of PLY-014 and is how the
// original proposal ended up with spurious negative delays. null in ⇒ null
// out: the caller must not report anything before calibration completes.
function computeDelayMs(nowMs, timestampMs) {
    if (nowMs === null || nowMs === undefined) return null;
    if (!Number.isFinite(timestampMs)) return null;
    return nowMs - timestampMs;
}

exports["isValidObsTimestampMessage"] = isValidObsTimestampMessage;
exports["computeDelayMs"] = computeDelayMs;
};

__modules["/catchup-controller.mjs"] = function (module, exports, __require) {
// Live-edge catch-up: decides when the measured end-to-end delay (see
// main.js's lastP2PDelayMs/reportP2PDelay) has drifted far enough above a
// target that the player should actively drain it, rather than only shrinking
// how much delay gets added going forward (which is all lowering SRTLatency or
// the playout buffer does).
//
// This used to actuate through video.playbackRate, which does not work: the
// element's source is a MediaStream, and for a MediaStream the rate is
// ignored. Measured in Chromium - assigning 2.0 leaves playbackRate reading
// back as 1, and currentTime keeps advancing at exactly wall clock - so every
// "catching up 1.05x" this reported was cosmetic and no delay was ever
// drained. Seeking and frame-dropping are equally unavailable for the same
// reason: a live MediaStream has no seekable timeline to move within.
//
// The one lever a browser does expose is the jitter buffer's target delay
// (jitterBufferTarget / playoutDelayHint), so the controller no longer
// actuates anything itself: it decides, and the caller supplies an `onCatchUp`
// actuator that lowers the pinned playout buffer while catch-up is engaged and
// restores it afterwards. With no actuator - which is the default, because a
// browser left on its own adaptive jitter buffer already drains excess delay
// by itself (see buffer-config.mjs) - the controller reports itself
// unavailable instead of claiming to be catching up.

// Hysteresis band: only speed up once delay exceeds target+HIGH, only
// return to 1.0x once it drops back under target+LOW. The gap between the
// two stops the controller from flapping rate right at a single threshold
// when delay hovers near it.
// Engages at DEFAULT_TARGET_MS + HIGH_MARGIN_MS = 1000ms (SRT-ingested h264 sits
// near 650ms on the edge path, which made 650ms flap permanently).
const DEFAULT_TARGET_MS = 850;
const HIGH_MARGIN_MS = 150; // engage catch-up above target+150ms
const LOW_MARGIN_MS = 50; // disengage below target+50ms

// A delay reading over this far above target would need several minutes of
// 1.05x to drain - almost certainly a stale/misdetected value (e.g. right
// after a reconnect) rather than something worth chasing at a barely
// perceptible rate. Leave it to buffering/reconnect logic instead of
// running hot indefinitely.
const MAX_CHASEABLE_EXCESS_MS = 5000;

class CatchUpController {
    // onCatchUp(engaged) is the actuator: called only when the decision
    // changes, with true to start draining and false to stop. It must return
    // true from an engage call when it actually did something; anything else
    // means "nothing to drain right now" and leaves the controller
    // disengaged. Leave it unset and the controller is inert - see the module
    // comment for why that is the right default.
    constructor(video, { targetMs = DEFAULT_TARGET_MS, onCatchUp = null } = {}) {
        this.video = video;
        this.targetMs = targetMs;
        this.onCatchUp = onCatchUp;
        this.catchingUp = false;
        this.enabled = true;
    }

    setTargetMs(targetMs) {
        this.targetMs = targetMs;
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) this._setCatchUp(false);
    }

    // Called once a second from main.js's updateStats() with the same
    // delayMs it displays as P2P Delay. Pass null/undefined when no fresh,
    // plausible reading exists (e.g. clock not yet calibrated) - the
    // controller holds its last rate rather than guessing.
    update(delayMs) {
        if (!this.enabled || delayMs === null || delayMs === undefined || !Number.isFinite(delayMs)) return;

        // Only safe to change rate while media is actually advancing.
        // readyState < 2 (HAVE_CURRENT_DATA) or an explicit pause/seek means
        // the browser is already stalled/not rendering - forcing playbackRate
        // here doesn't help and fights whatever recovery it's doing on its
        // own once it resumes.
        if (this.video.paused || this.video.seeking || this.video.readyState < 2) {
            this._setCatchUp(false);
            return;
        }

        const excess = delayMs - this.targetMs;

        if (excess > MAX_CHASEABLE_EXCESS_MS) {
            this._setCatchUp(false);
            return;
        }

        if (!this.catchingUp && excess > HIGH_MARGIN_MS) {
            this._setCatchUp(true);
        } else if (this.catchingUp && excess < LOW_MARGIN_MS) {
            this._setCatchUp(false);
        }
    }

    // Called on stopStream()/new session so a leftover engaged state doesn't
    // carry into the next play click before the first update() tick corrects it.
    reset() {
        this._setCatchUp(false);
    }

    _setCatchUp(engaged) {
        if (this.catchingUp === engaged) return;

        if (engaged) {
            // Engage only once the actuator confirms it did something. An
            // absent or declining actuator must leave catchingUp false:
            // reporting a state with no effect behind it is exactly what the
            // playbackRate version did for its whole life.
            if (!this.onCatchUp || this.onCatchUp(true) !== true) return;
            this.catchingUp = true;
            return;
        }

        this.catchingUp = false;
        if (this.onCatchUp) this.onCatchUp(false);
    }
}

exports["DEFAULT_TARGET_MS"] = DEFAULT_TARGET_MS;
exports["CatchUpController"] = CatchUpController;
};

__modules["/stall-watchdog.mjs"] = function (module, exports, __require) {
// Detects the "receiving bytes but decoding nothing" stall seen when the
// server-side forward path (Origin -> Edge -> this WHEP session) survives a
// publisher restart in a state where RTP keeps arriving but the browser's
// decoder never produces a frame (getStats() shows videoKbps > 0 while
// framesPerSecond stays 0 indefinitely - see the 2026-09-16 OBS
// stop/restart incident). WebRTC's own reconnect machinery (ICE restart,
// PeerConnection connectionState) doesn't catch this because the
// connection itself never drops - only the media pipeline downstream of it
// gets stuck.
//
// The fix that's actually been observed to work is exactly what a user
// clicking Start does: tear the whole session down and renegotiate from
// scratch. This module only decides *when* to do that automatically -
// startStream() is what main.js already runs on a manual click.

// Long enough that a real ABR layer switch or a brief renegotiation blip
// (which also reads fps=0 for a tick or two while the new track spins up)
// doesn't false-positive. Short enough that "keeps spinning for tens of
// seconds" doesn't happen unattended.
const DEFAULT_STALL_SECONDS = 8;

// Below this, "fps=0" is indistinguishable from no video track actually
// being active (audio-only ABR mode, or the very first ticks before any
// video byte has arrived) - not a stall.
const MIN_VIDEO_KBPS_TO_COUNT = 20;

// After triggering, ignore updates for a while - the recovery itself goes
// through the same zero-fps state for a few seconds while it renegotiates,
// which must not immediately retrigger.
const COOLDOWN_SECONDS = 20;

class StallWatchdog {
    constructor({ stallSeconds = DEFAULT_STALL_SECONDS, onStall } = {}) {
        this.stallSeconds = stallSeconds;
        this.onStall = onStall;
        this.zeroFpsStreak = 0;
        this.cooldownRemaining = 0;
    }

    // Called once a second from updateStats() with the same videoKbps/fps
    // it already computes. isVideoActive is whether the current track is
    // actually meant to show a picture right now (not audio-only, not
    // paused) - the caller already tracks this via abrEngine/videoPaused.
    update(videoKbps, fps, isVideoActive) {
        if (this.cooldownRemaining > 0) {
            this.cooldownRemaining--;
            return;
        }

        if (!isVideoActive || videoKbps < MIN_VIDEO_KBPS_TO_COUNT) {
            this.zeroFpsStreak = 0;
            return;
        }

        if (fps > 0) {
            this.zeroFpsStreak = 0;
            return;
        }

        this.zeroFpsStreak++;
        if (this.zeroFpsStreak >= this.stallSeconds) {
            this.zeroFpsStreak = 0;
            this.cooldownRemaining = COOLDOWN_SECONDS;
            if (this.onStall) this.onStall();
        }
    }

    reset() {
        this.zeroFpsStreak = 0;
        this.cooldownRemaining = 0;
    }
}

exports["StallWatchdog"] = StallWatchdog;
};

__modules["/lag-tracker.mjs"] = function (module, exports, __require) {
// Pull-side rebuffering (卡顿) tracker. A stall that lasts longer than the
// threshold counts as one lag event, and its full duration is added to the
// running lag total. main.js reports the totals on the viewer session
// (start/heartbeat/stop), ppcenter stores them on play_sessions, and the
// hourly aggregator derives a rebuffering rate = lagDuration / watchedDuration.
//
// A stall is driven by the <video> element's waiting/playing events: waiting
// fires when playback cannot advance because data is not available, playing
// when it resumes. A brief renegotiation or ABR layer switch also reads as
// waiting for a tick or two, which is exactly why sub-threshold stalls are
// dropped instead of counted.

const DEFAULT_LAG_THRESHOLD_MS = 2000;

class LagTracker {
    constructor({ thresholdMs = DEFAULT_LAG_THRESHOLD_MS } = {}) {
        this.thresholdMs = thresholdMs;
        this.count = 0;
        this.durationMs = 0;
        this.stalledSince = null;
    }

    // Called when playback is expected to be advancing but is not.
    beginStall(nowMs = Date.now()) {
        if (this.stalledSince === null) this.stalledSince = nowMs;
    }

    // Called when playback resumes. Returns true when this stall was counted
    // as a lag event (its duration exceeded the threshold).
    endStall(nowMs = Date.now()) {
        if (this.stalledSince === null) return false;
        const duration = nowMs - this.stalledSince;
        this.stalledSince = null;
        if (duration <= this.thresholdMs) return false;
        this.count++;
        this.durationMs += duration;
        return true;
    }

    // Drop an in-progress stall without counting it (user pause/seek, teardown).
    cancelStall() {
        this.stalledSince = null;
    }

    reset() {
        this.count = 0;
        this.durationMs = 0;
        this.stalledSince = null;
    }
}

exports["DEFAULT_LAG_THRESHOLD_MS"] = DEFAULT_LAG_THRESHOLD_MS;
exports["LagTracker"] = LagTracker;
};

__modules["/ppwebpublish.mjs"] = function (module, exports, __require) {
// Browser (web) publishing for PPCDN: capture getUserMedia in the page and
// push it to an Origin over WHIP, without installing a desktop client and
// without ever holding the appSecret.
//
// This is the client half of the design in
// docs/design/ppcdn-web-publish-design.zh-CN.md. The control plane
// (ppcenter) mints a short-lived WHIP bearer token for the page via a
// user-JWT-authenticated call (requestBrowserPublishSession); this module
// then opens one WHIP PeerConnection and keeps the token fresh.
//
// Codec decision: H264, not VP8. ppmmx's ABR ladder, its in-band SEI delay
// measurement and P2P are all H264/H265-only (see from_stream.go and
// sei_timestamp.go on the media side), and Chrome's default codec order puts
// VP8 first - so publish *must* call preferH264() before createOffer or the
// stream silently loses adaptive bitrate and end-to-end latency telemetry.
const { P2PAnswerer } = __require("/p2p-answerer.mjs");
const { gatherNatProbe } = __require("/nat-probe.mjs");
// H264 with packetization-mode=1 is ranked first because the node's SEI
// extractor decodes mode 1 (mode 0 would drop every fragmented SEI on a
// simulcast/IDR stream).

// preferH264Order reorders a capability list so the codecs the media plane
// can actually exploit come first: H264/packetization-mode=1, then H264/mode 0,
// then everything else (VP8/VP9/AV1...). Stable, so the relative order of the
// non-H264 codecs is preserved. Exported for testing.
function preferH264Order(codecs) {
    const rank = (codec) => {
        const mime = String(codec?.mimeType || '').toLowerCase();
        if (!mime.includes('h264')) return 2;
        return /packetization-mode=1/.test(codec?.sdpFmtpLine || '') ? 0 : 1;
    };
    return [...codecs].sort((a, b) => rank(a) - rank(b));
}

// preferH264 pushes an H264-first codec preference onto a video transceiver.
// Returns true when preferences were applied, false when the environment
// can't do it (older browser), so the caller can warn rather than assume.
function preferH264(transceiver) {
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return false;
    if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') return false;
    const caps = RTCRtpSender.getCapabilities('video');
    if (!caps || !Array.isArray(caps.codecs) || caps.codecs.length === 0) return false;
    try {
        transceiver.setCodecPreferences(preferH264Order(caps.codecs));
        return true;
    } catch {
        return false;
    }
}

// detectPublishVideoCodec picks the publish codec from what this browser can
// actually encode: H264 when available (full feature set), otherwise VP8
// (relay-only fallback - no ABR/P2P/SEI). Defaults to H264 when capability
// introspection is unavailable, since that's what the Origin prefers and a
// genuinely H264-incapable browser will fail loudly rather than silently.
function detectPublishVideoCodec() {
    if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') return 'h264';
    const caps = RTCRtpSender.getCapabilities('video');
    const codecs = caps?.codecs || [];
    const can = (name) => codecs.some((c) => String(c?.mimeType || '').toLowerCase().includes(name));
    if (can('h264')) return 'h264';
    if (can('vp8')) return 'vp8';
    return 'h264';
}

// --- In-band absolute-timestamp SEI injection (H264) ---------------------
//
// The media plane measures end-to-end latency from an absolute UTC-ms value
// embedded in an SEI user_data_unregistered message (ppmmx's
// FindOBSAbsTimestampSEI, pplayer's findObsAbsTimestamp). ppobs injects this
// per frame; a browser publisher must do the same or the stream silently
// loses its real delay telemetry (SLA, AI report, P2P Delay). The wire format
// is fixed and shared, so it is duplicated here rather than imported:
//   SEI NAL (H264 type 6) { payloadType=5, payloadSize=24,
//     user_data_unregistered UUID "OBS-ABSTSS-SEI-v1" (16B),
//     absolute UTC milliseconds big-endian (8B) }
const OBS_ABS_TS_SEI_UUID = new Uint8Array([
    0x4F, 0x42, 0x53, 0x2D, 0x41, 0x42, 0x53, 0x54, // "OBS-ABST"
    0x53, 0x2D, 0x53, 0x45, 0x49, 0x2D, 0x76, 0x31, // "S-SEI-v1"
]);
const ABS_TS_SEI_PAYLOAD_TYPE = 5;
const ABS_TS_SEI_PAYLOAD_SIZE = 24;

// escapeRBSP inserts H.264 emulation-prevention bytes (00 00 -> 00 00 03 when
// the next byte is <= 0x03), the inverse of the parser's unescapeRBSP.
function escapeRBSP(rbsp) {
    const out = [];
    let zeroRun = 0;
    for (let i = 0; i < rbsp.length; i++) {
        const b = rbsp[i];
        if (zeroRun >= 2 && b <= 0x03) {
            out.push(0x03);
            zeroRun = 0;
        }
        out.push(b);
        zeroRun = (b === 0) ? zeroRun + 1 : 0;
    }
    return new Uint8Array(out);
}

// buildAbsTimestampNAL builds the SEI NAL (header + escaped RBSP, no start
// code) for an absolute UTC-millisecond timestamp. Exported for testing.
function buildAbsTimestampNAL(timestampMs) {
    // +1 for rbsp_trailing_bits (a single stop bit, 0x80): without it a
    // timestamp whose last byte is zero leaves the NAL ending in zero bytes,
    // which both parsers strip as padding - truncating the payload. The stop
    // bit also correctly terminates the SEI RBSP.
    const rbsp = new Uint8Array(2 + ABS_TS_SEI_PAYLOAD_SIZE + 1);
    rbsp[0] = ABS_TS_SEI_PAYLOAD_TYPE;
    rbsp[1] = ABS_TS_SEI_PAYLOAD_SIZE;
    rbsp.set(OBS_ABS_TS_SEI_UUID, 2);
    let ts = BigInt(Math.max(0, Math.round(timestampMs)));
    for (let i = 0; i < 8; i++) {
        rbsp[2 + 16 + (7 - i)] = Number(ts & 0xFFn);
        ts >>= 8n;
    }
    rbsp[rbsp.length - 1] = 0x80;
    const escaped = escapeRBSP(rbsp);
    const nal = new Uint8Array(1 + escaped.length);
    nal[0] = 0x06; // H264 SEI, nal_ref_idc=0
    nal.set(escaped, 1);
    return nal;
}

const ANNEX_B_START = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

function looksLikeAnnexB(data) {
    if (data.length < 3 || data[0] !== 0 || data[1] !== 0) return false;
    if (data[2] === 1) return true;
    return data.length >= 4 && data[2] === 0 && data[3] === 1;
}

// injectAbsTimestampSEI prepends an SEI NAL to one Annex-B access unit. It
// returns the input unchanged when the frame isn't Annex-B (nothing safe to
// do), so telemetry never corrupts the stream. Exported for testing.
function injectAbsTimestampSEI(data, timestampMs) {
    if (!looksLikeAnnexB(data)) return data;
    const nal = buildAbsTimestampNAL(timestampMs);
    const out = new Uint8Array(ANNEX_B_START.length + nal.length + data.length);
    out.set(ANNEX_B_START, 0);
    out.set(nal, ANNEX_B_START.length);
    out.set(data, ANNEX_B_START.length + nal.length);
    return out;
}

// attachAbsTimestampInjector wires an Insertable Streams transform onto a
// video RTCRtpSender so every encoded frame carries the SEI. The frame's own
// RTP-domain timestamp (µs) is mapped to the wall clock via an anchor taken on
// the first frame, which keeps per-frame timing accurate instead of stamping
// the injection moment. Returns false when unsupported (non-Chromium), so the
// caller can fall back to the DataChannel relay.
function attachAbsTimestampInjector(sender, { now = () => Date.now() } = {}) {
    if (!sender || typeof sender.createEncodedStreams !== 'function') return false;
    let streams;
    try {
        streams = sender.createEncodedStreams();
    } catch {
        return false;
    }
    let anchorRtpUs = null;
    let anchorWallMs = 0;
    const transform = new TransformStream({
        transform(frame, controller) {
            try {
                if (anchorRtpUs === null) {
                    anchorRtpUs = frame.timestamp;
                    anchorWallMs = now();
                }
                const wallMs = anchorWallMs + (frame.timestamp - anchorRtpUs) / 1000;
                const data = new Uint8Array(frame.data);
                const injected = injectAbsTimestampSEI(data, wallMs);
                if (injected !== data) {
                    controller.enqueue(replaceFrameData(frame, injected.buffer));
                    return;
                }
            } catch {
                // Telemetry must never break publishing; forward as-is.
            }
            controller.enqueue(frame);
        },
    });
    streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch(() => {});
    return true;
}

// replaceFrameData returns a frame carrying new bytes. Chromium's
// RTCRtpScriptTransform/Insertable Streams exposes a constructor clone; older
// implementations accept a direct assignment. Returns the frame unchanged if
// neither works.
function replaceFrameData(frame, data) {
    try {
        if (typeof RTCEncodedVideoFrame !== 'undefined') {
            return new RTCEncodedVideoFrame(frame, { data });
        }
    } catch {
        // Fall through to direct assignment.
    }
    try {
        frame.data = data;
    } catch {
        // Leave the original frame; better a missing SEI than a broken stream.
    }
    return frame;
}

function browserPublishUrl(ppcenter, suffix = '') {
    return new URL('/v1/publish/browser-requests' + suffix, ppcenter).toString();
}

async function readJSONResponse(response, label) {
    let body = null;
    try {
        body = await response.json();
    } catch {
        // Non-JSON body (nginx error page etc.) - fall through to the status.
    }
    if (!response.ok) {
        const code = body?.code || `http_${response.status}`;
        const error = new Error(`${label} failed: ${code}`);
        error.code = code;
        error.status = response.status;
        throw error;
    }
    return body;
}

// requestBrowserPublishSession asks ppcenter for a WHIP credential. `config`
// is { ppcenter, token (console user JWT), appId, streamName, requestRegion? }.
async function requestBrowserPublishSession(config, { fetchImpl = fetch, signal } = {}) {
    const response = await fetchImpl(browserPublishUrl(config.ppcenter), {
        method: 'POST',
        signal,
        headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            appId: config.appId,
            streamName: config.streamName,
            ...(config.requestRegion ? { requestRegion: config.requestRegion } : {}),
            ...(config.codec ? { codec: config.codec } : {}),
            ...(config.enableP2P
                ? { enableP2P: true, natProbeId: config.natProbeId, clientId: config.clientId }
                : {}),
        }),
    });
    return readJSONResponse(response, 'browser publish request');
}

// refreshBrowserPublishSession re-mints the token against the same Origin and
// extends the session. Call it before decision.expiresAt elapses.
async function refreshBrowserPublishSession(config, sessionId, { fetchImpl = fetch, signal } = {}) {
    const response = await fetchImpl(browserPublishUrl(config.ppcenter, `/${encodeURIComponent(sessionId)}/refresh`), {
        method: 'POST',
        signal,
        headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json',
        },
        body: '{}',
    });
    return readJSONResponse(response, 'browser publish refresh');
}

// stopBrowserPublishSession releases the session so it stops counting against
// the per-user concurrency cap. Safe to call on teardown; a 404 (already
// expired/ended) is treated as success.
async function stopBrowserPublishSession(config, sessionId, { fetchImpl = fetch, signal } = {}) {
    const response = await fetchImpl(browserPublishUrl(config.ppcenter, `/${encodeURIComponent(sessionId)}`), {
        method: 'DELETE',
        signal,
        headers: { 'Authorization': `Bearer ${config.token}` },
    });
    if (response.status === 404) return;
    await readJSONResponse(response, 'browser publish stop');
}

function randomClientID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `webpub-${crypto.randomUUID()}`;
    }
    return `webpub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// probeBrowserPublisherNat is the browser publisher's default NAT-probe
// client: gather a public endpoint via STUN (reusing pplayer's gatherNatProbe)
// and register it as a publisher observation so P2P eligibility can pair the
// page with viewers. Returns { clientId, natProbeId, gathered } to hand to
// BrowserPublisher's natProbe option, or null when nothing usable was found.
// The clientId must be stable from probe to session-create because the probe
// handle is derived from (appId, clientId) server-side.
async function probeBrowserPublisherNat(config, { fetchImpl = fetch, gather = gatherNatProbe, clientId = null, signal } = {}) {
    const id = clientId || config.clientId || randomClientID();
    const gathered = await gather(config.ppcenter);
    if (!gathered) return null;
    const response = await fetchImpl(new URL('/v1/publish/browser-probe', config.ppcenter).toString(), {
        method: 'POST',
        signal,
        headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            appId: config.appId,
            streamName: config.streamName,
            clientId: id,
            natType: gathered.natType,
            publicIp: gathered.publicIp,
            publicPort: gathered.publicPort,
        }),
    });
    const body = await readJSONResponse(response, 'browser publish probe');
    return { clientId: id, natProbeId: body.probeId, gathered };
}

// waitForIceGathering resolves once ICE gathering completes, or after
// timeoutMs, so a non-trickle WHIP publish doesn't hang on a candidate source
// that never finishes. WHIP permits sending the offer as soon as gathering is
// done; trickle is an optimization we can add later.
function waitForIceGathering(pc, timeoutMs) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            pc.removeEventListener?.('icegatheringstatechange', onChange);
            clearTimeout(timer);
            resolve();
        };
        const onChange = () => {
            if (pc.iceGatheringState === 'complete') done();
        };
        const timer = setTimeout(done, timeoutMs);
        pc.addEventListener?.('icegatheringstatechange', onChange);
    });
}

// whipPublish performs the WHIP exchange on an already-populated
// RTCPeerConnection: local offer -> POST to the Origin with the bearer token
// -> apply the answer. Returns the resource Location when the Origin provides
// one (used later for PATCH/ICE trickle).
async function whipPublish(decision, pc, { fetchImpl = fetch, signal, iceGatheringTimeoutMs = 2000 } = {}) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, iceGatheringTimeoutMs);

    const response = await fetchImpl(decision.whipUrl, {
        method: 'POST',
        signal,
        headers: {
            'Authorization': `Bearer ${decision.bearerToken}`,
            'Content-Type': 'application/sdp',
        },
        body: pc.localDescription.sdp,
    });
    if (!response.ok) {
        throw new Error(`WHIP publish failed with status ${response.status}`);
    }
    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    return response.headers?.get?.('Location') || '';
}

const DEFAULT_MEDIA_CONSTRAINTS = {
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

// buildMediaConstraints picks getUserMedia constraints. audioOnly drops video
// entirely (mobile/audio use); facingMode selects the camera on devices with
// more than one; an explicit mediaConstraints overrides both.
function buildMediaConstraints({ audioOnly = false, facingMode = 'user', mediaConstraints = null } = {}) {
    if (mediaConstraints) return mediaConstraints;
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    if (facingMode) video.facingMode = facingMode;
    return {
        video: audioOnly ? false : video,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    };
}

// DEFAULT_SIMULCAST_LAYERS is a three-rung H264 simulcast ladder (full / half /
// quarter resolution). ppmmx accepts up to 5 H264 layers; three covers the
// common weak-network range without multiplying the publisher's encode cost.
const DEFAULT_SIMULCAST_LAYERS = [
    { rid: 'h', scaleResolutionDownBy: 1.0, maxBitrate: 1_500_000 },
    { rid: 'm', scaleResolutionDownBy: 2.0, maxBitrate: 700_000 },
    { rid: 'l', scaleResolutionDownBy: 4.0, maxBitrate: 300_000 },
];

// BrowserPublisher ties it together: create the session, capture, publish,
// keep the token fresh, and tear everything down on stop. All browser
// primitives are injectable so this can be unit-tested under Node and reused
// with non-default constraints.
class BrowserPublisher {
    constructor({
        ppcenter,
        token,
        appId,
        streamName,
        requestRegion = '',
        mediaConstraints = null,
        // audioOnly/formats: mobile adaptation. audioOnly publishes audio only.
        audioOnly = false,
        // facingMode: initial camera on multi-camera devices.
        facingMode = 'user',
        // codec: null (auto-detect) | 'h264' | 'vp8'. VP8 is relay-only.
        codec = null,
        // simulcast: false | true (use DEFAULT_SIMULCAST_LAYERS) | explicit array.
        simulcast = false,
        // seiTimestamps: inject the in-band absolute-timestamp SEI so the
        // media plane can measure real end-to-end delay (H264 only).
        seiTimestamps = false,
        // p2p: also serve viewers directly. Requires natProbe (H264 only), the
        // { clientId, natProbeId } pair obtained from the browser publisher NAT
        // probe (POST /v1/publish/browser-probe).
        p2p = false,
        natProbe = null,
        // autoNatProbe: when p2p is on and no natProbe was supplied, gather and
        // register one via probeNat (browser NAT probe).
        autoNatProbe = true,
        probeNat = probeBrowserPublisherNat,
        fetchImpl = fetch,
        getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        createPeerConnection = () => new RTCPeerConnection(),
        detectCodec = detectPublishVideoCodec,
        P2PAnswererClass = P2PAnswerer,
        refreshLeadMs = 60 * 1000,
        // Refresh at least this often regardless of token TTL, so the server's
        // per-user idle timeout (which treats a session that stopped
        // refreshing as dead) never reaps a live page.
        maxRefreshMs = 60 * 1000,
        iceGatheringTimeoutMs = 2000,
        onState = () => {},
    }) {
        this.config = { ppcenter, token, appId, streamName, requestRegion, ...(codec ? { codec } : {}) };
        this.codec = codec;
        this.detectCodec = detectCodec;
        this.audioOnly = audioOnly;
        this.facingMode = facingMode;
        this.mediaConstraints = buildMediaConstraints({ audioOnly, facingMode, mediaConstraints });
        this.simulcastLayers = simulcast === true ? DEFAULT_SIMULCAST_LAYERS : (Array.isArray(simulcast) ? simulcast : null);
        this.seiTimestamps = seiTimestamps;
        this.p2p = p2p;
        this.natProbe = natProbe;
        this.autoNatProbe = autoNatProbe;
        this.probeNat = probeNat;
        this.fetchImpl = fetchImpl;
        this.getUserMedia = getUserMedia;
        this.createPeerConnection = createPeerConnection;
        this.P2PAnswererClass = P2PAnswererClass;
        this.refreshLeadMs = refreshLeadMs;
        this.maxRefreshMs = maxRefreshMs;
        this.iceGatheringTimeoutMs = iceGatheringTimeoutMs;
        this.onState = onState;

        this.pc = null;
        this.stream = null;
        this.decision = null;
        this.refreshTimer = null;
        this.answerer = null;
        this.stopped = false;
    }

    async start() {
        this.onState('requesting-session');
        this.codec = (this.codec || this.detectCodec()).toLowerCase();
        this.config = { ...this.config, codec: this.codec };
        // P2P is H264-only and needs a publisher NAT probe result. Without an
        // explicit natProbe, gather+register one now.
        if (this.p2p && this.codec === 'h264' && !this.natProbe?.natProbeId && this.autoNatProbe) {
            this.onState('nat-probe');
            try {
                this.natProbe = await this.probeNat(this.config, { fetchImpl: this.fetchImpl });
            } catch (error) {
                this.onState('nat-probe-failed', error);
            }
        }
        if (this.p2p && this.codec === 'h264' && this.natProbe?.clientId && this.natProbe?.natProbeId) {
            this.config = {
                ...this.config,
                enableP2P: true,
                clientId: this.natProbe.clientId,
                natProbeId: this.natProbe.natProbeId,
            };
        }
        this.decision = await requestBrowserPublishSession(this.config, { fetchImpl: this.fetchImpl });

        // From here a server-side session exists. Every later failure (camera
        // denied, WHIP rejected, ICE timeout...) must release it, otherwise the
        // session keeps counting against the per-user cap until its idle
        // timeout and a few failed starts lock the user out with
        // too_many_publish_sessions. stop() also closes the peer connection and
        // the capture tracks.
        try {
            this.onState('capturing');
            this.stream = await this.getUserMedia(this.mediaConstraints);

            this.onState('publishing');
            this.pc = this.createPeerConnection();
            for (const track of this.stream.getTracks()) {
                this.addPublisherTrack(track);
            }
            await whipPublish(this.decision, this.pc, {
                fetchImpl: this.fetchImpl,
                iceGatheringTimeoutMs: this.iceGatheringTimeoutMs,
            });

            this.startP2P();

            this.scheduleRefresh();
            this.onState('live');
            return this.decision;
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    // startP2P attaches the answerer when the decision carries a publisher
    // signaling credential (only present when the server issued P2P).
    startP2P() {
        const signal = this.decision?.signal;
        if (!signal?.signalUrl || !signal?.token) return;
        this.answerer = new this.P2PAnswererClass({
            session: {
                signalUrl: signal.signalUrl,
                token: signal.token,
                stunServers: this.decision.stunServers ?? [],
                maxPeers: this.decision.maxP2PSessions ?? 3,
            },
            mediaStream: this.stream,
            onSignal: (message) => this.onState('p2p', message),
            onError: (error) => this.onState('p2p-error', error),
        });
        this.answerer.start();
    }

    // addPublisherTrack adds one sendonly transceiver per captured track,
    // applying simulcast (video only) and H264 preference, and optionally the
    // SEI injector. VP8 is relay-only: no simulcast ladder (the ABR ladder is
    // H264/H265-only), no H264 preference, no SEI.
    addPublisherTrack(track) {
        const video = track.kind === 'video';
        const h264 = this.codec !== 'vp8';
        const options = { direction: 'sendonly', streams: [this.stream] };
        if (video && this.simulcastLayers && h264) options.sendEncodings = this.simulcastLayers;
        const transceiver = this.pc.addTransceiver(track, options);
        if (video) {
            this.videoSender = transceiver?.sender ?? null;
            if (h264) {
                preferH264(transceiver);
                if (this.seiTimestamps) attachAbsTimestampInjector(transceiver?.sender);
            }
        }
        return transceiver;
    }

    // switchCamera swaps the active camera (front/back) on a live publish by
    // replacing the video track on the WHIP sender and every P2P peer sender,
    // so the switch is seamless (no renegotiation on the same resolution).
    async switchCamera() {
        if (!this.stream || this.audioOnly) return false;
        const next = this.facingMode === 'user' ? 'environment' : 'user';
        const replacement = await this.getUserMedia({
            video: { facingMode: next, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
            audio: false,
        });
        const newTrack = replacement.getVideoTracks?.()[0];
        if (!newTrack) return false;

        if (this.videoSender?.replaceTrack) {
            await this.videoSender.replaceTrack(newTrack);
        }
        this.answerer?.replaceVideoTrack?.(newTrack);

        const oldTrack = this.stream.getVideoTracks?.()[0];
        if (oldTrack) {
            this.stream.removeTrack?.(oldTrack);
            oldTrack.stop();
        }
        this.stream.addTrack?.(newTrack);
        this.facingMode = next;
        this.onState('camera-switched', next);
        return true;
    }

    scheduleRefresh() {
        const expiresAt = Date.parse(this.decision?.expiresAt || '');
        const untilExpiry = Number.isNaN(expiresAt) ? this.maxRefreshMs : expiresAt - Date.now() - this.refreshLeadMs;
        const delay = Math.min(this.maxRefreshMs, Math.max(5_000, untilExpiry));
        this.refreshTimer = setTimeout(() => {
            this.refresh().catch((error) => this.onState('refresh-failed', error));
        }, delay);
    }

    async refresh() {
        if (!this.decision) return;
        this.decision = await refreshBrowserPublishSession(this.config, this.decision.sessionId, { fetchImpl: this.fetchImpl });
        this.onState('refreshed');
        this.scheduleRefresh();
    }

    async stop() {
        this.stopped = true;
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.answerer?.stop();
        this.answerer = null;
        try {
            this.pc?.close?.();
        } catch {
            // Already closed.
        }
        for (const track of this.stream?.getTracks?.() || []) track.stop();
        const sessionId = this.decision?.sessionId;
        this.pc = null;
        this.stream = null;
        this.decision = null;
        if (sessionId) {
            try {
                await stopBrowserPublishSession(this.config, sessionId, { fetchImpl: this.fetchImpl });
            } catch (error) {
                this.onState('stop-failed', error);
            }
        }
        this.onState('stopped');
    }
}

exports["preferH264Order"] = preferH264Order;
exports["preferH264"] = preferH264;
exports["detectPublishVideoCodec"] = detectPublishVideoCodec;
exports["buildAbsTimestampNAL"] = buildAbsTimestampNAL;
exports["injectAbsTimestampSEI"] = injectAbsTimestampSEI;
exports["attachAbsTimestampInjector"] = attachAbsTimestampInjector;
exports["requestBrowserPublishSession"] = requestBrowserPublishSession;
exports["refreshBrowserPublishSession"] = refreshBrowserPublishSession;
exports["stopBrowserPublishSession"] = stopBrowserPublishSession;
exports["probeBrowserPublisherNat"] = probeBrowserPublisherNat;
exports["whipPublish"] = whipPublish;
exports["DEFAULT_MEDIA_CONSTRAINTS"] = DEFAULT_MEDIA_CONSTRAINTS;
exports["buildMediaConstraints"] = buildMediaConstraints;
exports["DEFAULT_SIMULCAST_LAYERS"] = DEFAULT_SIMULCAST_LAYERS;
exports["BrowserPublisher"] = BrowserPublisher;
};

__modules["/p2p-answerer.mjs"] = function (module, exports, __require) {
// Browser P2P publisher (answerer) for PPCDN.
//
// The viewer side of P2P (pplayer's P2PPlaybackPath) sends an SDP `offer` over
// ppcenter's signaling WebSocket; this is the publisher end that must answer
// it. It mirrors ppobs's C++ answerer: one RTCPeerConnection per viewer
// session, capped at the stream's P2P slot count, with the captured media
// tracks added sendonly. Signaling message shapes and the close/fail/connected
// vocabulary match ppcenter/internal/p2p/signal.go and pplayer's player path.
//
// Only H264 is supported (P2P is H264-only server-side); the caller must not
// provision this when publishing VP8.
class P2PAnswerer {
    constructor({
        session,               // { signalUrl, token, stunServers?, maxPeers? }
        mediaStream,           // the local MediaStream to send
        WebSocketClass = globalThis.WebSocket,
        PeerConnectionClass = globalThis.RTCPeerConnection,
        onSignal = () => {},
        onError = () => {},
    }) {
        this.session = session;
        this.mediaStream = mediaStream;
        this.WebSocketClass = WebSocketClass;
        this.PeerConnectionClass = PeerConnectionClass;
        this.onSignal = onSignal;
        this.onError = onError;

        this.ws = null;
        this.peers = new Map(); // sessionId -> { pc, pendingCandidates }
        this.seq = 0;
        this.stopped = false;
    }

    start() {
        this.onSignal({ type: 'ws-connecting', url: this.session.signalUrl });
        this.ws = new this.WebSocketClass(this.session.signalUrl, [
            'ppcdn-p2p-v1', `ppcdn-token.${this.session.token}`,
        ]);
        this.ws.onopen = () => this.onSignal({ type: 'ws-open' });
        this.ws.onmessage = (event) => { this.#onMessage(JSON.parse(event.data)).catch(this.#fail); };
        this.ws.onerror = () => this.#fail(new Error('P2P publisher signaling failed'));
        this.ws.onclose = () => { if (!this.stopped) this.#fail(new Error('P2P publisher signaling closed')); };
    }

    get peerCount() { return this.peers.size; }

    async #onMessage(message) {
        if (this.stopped) return;
        this.onSignal(message);
        switch (message.type) {
            case 'ready':
                break;
            case 'offer':
                await this.#onOffer(message);
                break;
            case 'ice':
                await this.#onIce(message);
                break;
            case 'close':
            case 'fail':
                this.#dropPeer(message.sessionId);
                break;
            case 'error':
                this.onSignal({ type: 'remote-error', reason: message.reason });
                break;
            default:
                break;
        }
    }

    async #onOffer(message) {
        const sessionId = message.sessionId;
        if (!sessionId || this.peers.has(sessionId)) return;
        if (this.peers.size >= (this.session.maxPeers ?? 3)) {
            this.#send({ type: 'fail', sessionId, reason: 'publisher at capacity' });
            return;
        }
        const pc = new this.PeerConnectionClass(this.#pcConfig());
        const entry = { pc, pendingCandidates: [] };
        this.peers.set(sessionId, entry);
        this.onSignal({ type: 'peer-created', sessionId });

        pc.onicecandidate = (event) => {
            if (event.candidate) this.#send({ type: 'ice', sessionId, candidate: event.candidate.toJSON() });
        };
        pc.onconnectionstatechange = () => {
            this.onSignal({ type: 'peer-connection', sessionId, value: pc.connectionState });
            if (pc.connectionState === 'connected') {
                this.#send({ type: 'connected', sessionId });
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                this.#send({ type: 'fail', sessionId, reason: 'connection failed' });
                this.#dropPeer(sessionId);
            }
        };

        // Answer the offer's OWN m-lines. The viewer offers one recvonly video
        // and one recvonly audio m-line; we attach our captured tracks to those
        // transceivers and flip them to sendonly. Adding new transceivers
        // instead would leave the offered m-lines unanswered (recvonly) and the
        // viewer would receive no media - the answer arrives but the player
        // gets no track and falls back to edge.
        await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        for (const candidate of entry.pendingCandidates) await pc.addIceCandidate(candidate);
        entry.pendingCandidates = [];

        const tracks = this.mediaStream.getTracks();
        for (const transceiver of pc.getTransceivers?.() ?? []) {
            const kind = transceiver.receiver?.track?.kind;
            const track = tracks.find((t) => t.kind === kind);
            if (track) {
                transceiver.direction = 'sendonly';
                await transceiver.sender?.replaceTrack?.(track);
            } else {
                transceiver.direction = 'inactive';
            }
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.#send({ type: 'answer', sessionId, sdp: answer.sdp });
    }

    async #onIce(message) {
        const entry = this.peers.get(message.sessionId);
        if (!entry || !message.candidate) return;
        if (entry.pc.remoteDescription) {
            await entry.pc.addIceCandidate(message.candidate);
        } else {
            entry.pendingCandidates.push(message.candidate);
        }
    }

    #dropPeer(sessionId) {
        const entry = this.peers.get(sessionId);
        if (!entry) return;
        this.peers.delete(sessionId);
        try { entry.pc.close(); } catch { /* already closed */ }
        this.onSignal({ type: 'peer-closed', sessionId });
    }

    // replaceVideoTrack swaps the outgoing video track on every peer (e.g. a
    // front/back camera switch) without renegotiating, mirroring the WHIP
    // sender replacement BrowserPublisher.switchCamera does.
    replaceVideoTrack(track) {
        for (const { pc } of this.peers.values()) {
            const sender = pc.getSenders?.().find((s) => s.track?.kind === 'video');
            try { sender?.replaceTrack?.(track); } catch { /* ignore */ }
        }
    }

    #pcConfig() {
        const stunUrls = (this.session.stunServers ?? []).filter(
            (url) => typeof url === 'string' && (url.startsWith('stun:') || url.startsWith('stuns:')));
        return stunUrls.length ? { iceServers: stunUrls.map((urls) => ({ urls })) } : undefined;
    }

    #send(message) {
        if (!this.ws || this.ws.readyState !== this.WebSocketClass.OPEN) return;
        this.seq += 1;
        this.ws.send(JSON.stringify({ v: 1, seq: this.seq, sentAt: Date.now(), ...message }));
    }

    #fail(error) {
        if (!this.stopped) this.onError(error);
    }

    stop(reason = 'stopped') {
        if (this.stopped) return;
        this.stopped = true;
        for (const sessionId of [...this.peers.keys()]) {
            this.#send({ type: 'close', sessionId, reason });
            this.#dropPeer(sessionId);
        }
        this.ws?.close();
    }
}

exports["P2PAnswerer"] = P2PAnswerer;
};

const __sdk = __require("/pplayer.js");
const __publisher = __require("/ppwebpublish.mjs");
const PPPlayer = __sdk.PPPlayer;
const { preferH264Order, preferH264, detectPublishVideoCodec, buildAbsTimestampNAL, injectAbsTimestampSEI, attachAbsTimestampInjector, requestBrowserPublishSession, refreshBrowserPublishSession, stopBrowserPublishSession, probeBrowserPublisherNat, whipPublish, DEFAULT_MEDIA_CONSTRAINTS, buildMediaConstraints, DEFAULT_SIMULCAST_LAYERS, BrowserPublisher } = __publisher;
if (typeof window !== 'undefined') window.PPPlayer = PPPlayer;
export { PPPlayer, preferH264Order, preferH264, detectPublishVideoCodec, buildAbsTimestampNAL, injectAbsTimestampSEI, attachAbsTimestampInjector, requestBrowserPublishSession, refreshBrowserPublishSession, stopBrowserPublishSession, probeBrowserPublisherNat, whipPublish, DEFAULT_MEDIA_CONSTRAINTS, buildMediaConstraints, DEFAULT_SIMULCAST_LAYERS, BrowserPublisher };
export default PPPlayer;
