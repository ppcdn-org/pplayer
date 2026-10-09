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
import { P2PAnswerer } from './p2p-answerer.mjs';
import { gatherNatProbe } from './nat-probe.mjs';
// H264 with packetization-mode=1 is ranked first because the node's SEI
// extractor decodes mode 1 (mode 0 would drop every fragmented SEI on a
// simulcast/IDR stream).

// preferH264Order reorders a capability list so the codecs the media plane
// can actually exploit come first: H264/packetization-mode=1, then H264/mode 0,
// then everything else (VP8/VP9/AV1...). Stable, so the relative order of the
// non-H264 codecs is preserved. Exported for testing.
export function preferH264Order(codecs) {
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
export function preferH264(transceiver) {
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
export function detectPublishVideoCodec() {
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
export function buildAbsTimestampNAL(timestampMs) {
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
export function injectAbsTimestampSEI(data, timestampMs) {
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
export function attachAbsTimestampInjector(sender, { now = () => Date.now() } = {}) {
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
export async function requestBrowserPublishSession(config, { fetchImpl = fetch, signal } = {}) {
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
export async function refreshBrowserPublishSession(config, sessionId, { fetchImpl = fetch, signal } = {}) {
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
export async function stopBrowserPublishSession(config, sessionId, { fetchImpl = fetch, signal } = {}) {
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
export async function probeBrowserPublisherNat(config, { fetchImpl = fetch, gather = gatherNatProbe, clientId = null, signal } = {}) {
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
export async function whipPublish(decision, pc, { fetchImpl = fetch, signal, iceGatheringTimeoutMs = 2000 } = {}) {
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

export const DEFAULT_MEDIA_CONSTRAINTS = {
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

// DEFAULT_SIMULCAST_LAYERS is a three-rung H264 simulcast ladder (full / half /
// quarter resolution). ppmmx accepts up to 5 H264 layers; three covers the
// common weak-network range without multiplying the publisher's encode cost.
export const DEFAULT_SIMULCAST_LAYERS = [
    { rid: 'h', scaleResolutionDownBy: 1.0, maxBitrate: 1_500_000 },
    { rid: 'm', scaleResolutionDownBy: 2.0, maxBitrate: 700_000 },
    { rid: 'l', scaleResolutionDownBy: 4.0, maxBitrate: 300_000 },
];

// BrowserPublisher ties it together: create the session, capture, publish,
// keep the token fresh, and tear everything down on stop. All browser
// primitives are injectable so this can be unit-tested under Node and reused
// with non-default constraints.
export class BrowserPublisher {
    constructor({
        ppcenter,
        token,
        appId,
        streamName,
        requestRegion = '',
        mediaConstraints = DEFAULT_MEDIA_CONSTRAINTS,
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
        iceGatheringTimeoutMs = 2000,
        onState = () => {},
    }) {
        this.config = { ppcenter, token, appId, streamName, requestRegion, ...(codec ? { codec } : {}) };
        this.codec = codec;
        this.detectCodec = detectCodec;
        this.mediaConstraints = mediaConstraints;
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
        this.iceGatheringTimeoutMs = iceGatheringTimeoutMs;
        this.onState = onState;

        this.pc = null;
        this.stream = null;
        this.decision = null;
        this.refreshTimer = null;
        this.answerer = null;
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
        if (video && h264) {
            preferH264(transceiver);
            if (this.seiTimestamps) attachAbsTimestampInjector(transceiver?.sender);
        }
        return transceiver;
    }

    scheduleRefresh() {
        const expiresAt = Date.parse(this.decision?.expiresAt || '');
        if (Number.isNaN(expiresAt)) return;
        const delay = Math.max(5_000, expiresAt - Date.now() - this.refreshLeadMs);
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
