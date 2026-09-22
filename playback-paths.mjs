import { applyPlayoutBuffer } from './buffer-config.mjs?v=20260922-2';
import { MediaMTXWebRTCReader } from './ppplayer.mjs?v=20260922-2';

// A browser only decodes an inbound WebRTC video track while something is
// consuming it. The race selects on framesDecoded > 0 (waitForVideoFrame
// below), but main.js attaches the visible <video> only once a path has
// *won* (its onSelected handler) - so with no consumer of its own, neither
// leg ever decodes a frame, never reports a first frame, and the race never
// selects anything. Playback deadlocks with both legs connected and silent.
//
// Confirmed in production 2026-09-22: this was the first time ppcenter ever
// returned mode=p2p-connect, so startRacedPlayback had never actually run
// against a real stream before - the edge-only path (main.js's
// negotiateAndConnect) sets video.srcObject directly in onTrack and is
// unaffected, which is why edge playback worked all along.
//
// Each leg therefore gets its own muted, effectively-invisible sink element
// purely to drive decoding, so framesDecoded can move and the race can be
// decided on real media as designed. The visible element still follows only
// the winner; the winner drops its sink at that point (releaseDecodeSink)
// so the same stream isn't decoded twice.
function createDecodeSink(stream) {
    // Unit tests run in Node with no DOM - the sink is a browser-only
    // concern and its absence must not break path construction.
    if (typeof document === 'undefined' || !stream) return null;
    const el = document.createElement('video');
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.srcObject = stream;
    // Not display:none - a video element that is never rendered can have
    // its decoding throttled. 1px and fully transparent is rendered, and
    // cannot be seen or interacted with.
    el.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(el);
    // Autoplay is allowed because the element is muted; a rejection here
    // (policy, or the element being torn down mid-start) must not surface
    // as an unhandled rejection.
    el.play?.()?.catch?.(() => {});
    return el;
}

function destroyDecodeSink(element) {
    if (!element) return;
    element.srcObject = null;
    element.remove?.();
}

function waitForVideoFrame(getPeerConnection, callback, intervalMs = 50) {
    let stopped = false;
    let timer = null;
    const check = async () => {
        if (stopped) return;
        const pc = getPeerConnection();
        if (pc) {
            const stats = await pc.getStats().catch(() => null);
            if (stats) {
                for (const report of stats.values()) {
                    if (report.type === 'inbound-rtp' && report.kind === 'video' && report.framesDecoded > 0) {
                        callback();
                        return;
                    }
                }
            }
        }
        timer = setTimeout(check, intervalMs);
    };
    check();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
}

export class EdgeWHEPPath {
    // ReaderClass stays injectable for the tests, but now defaults to the
    // imported SDK reader rather than a global - nothing assigns
    // window.MediaMTXWebRTCReader any more since the move to ES modules.
    constructor({ url, ReaderClass = MediaMTXWebRTCReader, bufferMs = null }) {
        this.url = url;
        this.ReaderClass = ReaderClass;
        this.bufferMs = bufferMs;
        this.reader = null;
        this.stream = null;
        this.cancelFrameWait = null;
        this.decodeSink = null;
    }

    start({ onFirstFrame, onFailed }) {
        this.reader = new this.ReaderClass({
            url: this.url,
            maxBitrate: 2500,
            onTrack: (event) => {
                this.stream = event.streams[0] || this.stream;
                // Receivers only exist once a track has arrived, so this is
                // the earliest point the buffer length can be set.
                if (this.bufferMs !== null) applyPlayoutBuffer(this.pc, this.bufferMs);
                if (!this.decodeSink) this.decodeSink = createDecodeSink(this.stream);
            },
            onConnected: () => {
                this.cancelFrameWait = waitForVideoFrame(() => this.reader?.pc, () => onFirstFrame({ stream: this.stream }));
            },
            onError: onFailed,
        });
    }

    // Called once this path has won the race and the visible element has
    // taken over as the stream's consumer - see createDecodeSink.
    releaseDecodeSink() {
        destroyDecodeSink(this.decodeSink);
        this.decodeSink = null;
    }

    stop() {
        this.cancelFrameWait?.();
        this.releaseDecodeSink();
        this.reader?.close();
        this.reader = null;
    }

    get pc() { return this.reader?.pc || null; }
    get sessionId() { return this.reader?.sessionId || null; }
}

export class P2PPlaybackPath {
    constructor({ session, WebSocketClass = globalThis.WebSocket, PeerConnectionClass = globalThis.RTCPeerConnection, bufferMs = null }) {
        this.session = session;
        this.WebSocketClass = WebSocketClass;
        this.PeerConnectionClass = PeerConnectionClass;
        this.bufferMs = bufferMs;
        this.ws = null;
        this.pc = null;
        this.stream = null;
        this.callbacks = null;
        this.pendingCandidates = [];
        this.cancelFrameWait = null;
        this.decodeSink = null;
        this.stopped = false;
        this.seq = 0;
    }

    start(callbacks) {
        this.callbacks = callbacks;
        this.ws = new this.WebSocketClass(this.session.signalUrl, [
            'ppcdn-p2p-v1', `ppcdn-token.${this.session.token}`,
        ]);
        this.ws.onmessage = (event) => this.#onSignal(JSON.parse(event.data));
        this.ws.onerror = () => this.#fail(new Error('P2P signaling failed'));
        this.ws.onclose = () => { if (!this.stopped) this.#fail(new Error('P2P signaling closed')); };
    }

    async #onSignal(message) {
        if (this.stopped) return;
        if (message.type === 'ready') {
            await this.#createOffer();
        } else if (message.type === 'answer' && message.sessionId === this.session.sessionId) {
            await this.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
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
        this.pc = new this.PeerConnectionClass(this.#iceServersConfig());
        this.pc.addTransceiver('video', { direction: 'recvonly' });
        this.pc.addTransceiver('audio', { direction: 'recvonly' });
        this.pc.ontrack = (event) => {
            this.stream = event.streams[0] || this.stream;
            // Same as the Edge path: receivers exist only once a track lands.
            if (this.bufferMs !== null) applyPlayoutBuffer(this.pc, this.bufferMs);
            if (!this.decodeSink) this.decodeSink = createDecodeSink(this.stream);
            if (!this.cancelFrameWait) {
                this.cancelFrameWait = waitForVideoFrame(() => this.pc, () => this.callbacks.onFirstFrame({ stream: this.stream }));
            }
        };
        this.pc.onicecandidate = (event) => {
            if (event.candidate) this.#send({ type: 'ice', candidate: event.candidate.toJSON() });
        };
        this.pc.onconnectionstatechange = () => {
            if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') this.#fail(new Error('P2P connection failed'));
        };
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this.#send({ type: 'offer', sdp: offer.sdp });
    }

    // ppcenter's own STUN address (models.STUNConfig.URLs() server-side)
    // rides in on session.stunServers, the same play-decision response
    // everything else here comes from. Without it this PeerConnection can
    // only gather `host` ICE candidates and never learns its own
    // public-facing address - P2P is then structurally unable to connect
    // for any viewer not on the publisher's LAN, regardless of NAT type.
    // Filtered the same way ppobs's C++ client filters this field
    // (ppcenter-signal.cpp/ppcenter-client.cpp): stun:/stuns: only, anything
    // else silently dropped rather than handed to the browser and rejected
    // at PeerConnection construction time.
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
        if (!this.stopped) this.callbacks?.onFailed(error);
    }

    // Called once this path has won the race and the visible element has
    // taken over as the stream's consumer - see createDecodeSink.
    releaseDecodeSink() {
        destroyDecodeSink(this.decodeSink);
        this.decodeSink = null;
    }

    stop(reason = 'stopped') {
        if (this.stopped) return;
        this.stopped = true;
        this.cancelFrameWait?.();
        this.releaseDecodeSink();
        if (this.ws?.readyState === this.WebSocketClass.OPEN) this.#send({ type: 'close', reason });
        this.ws?.close();
        this.pc?.close();
    }
}
