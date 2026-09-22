import { applyPlayoutBuffer } from './buffer-config.mjs?v=20260922-1';
import { MediaMTXWebRTCReader } from './ppplayer.mjs?v=20260922-1';

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
            },
            onConnected: () => {
                this.cancelFrameWait = waitForVideoFrame(() => this.reader?.pc, () => onFirstFrame({ stream: this.stream }));
            },
            onError: onFailed,
        });
    }

    stop() {
        this.cancelFrameWait?.();
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

    stop(reason = 'stopped') {
        if (this.stopped) return;
        this.stopped = true;
        this.cancelFrameWait?.();
        if (this.ws?.readyState === this.WebSocketClass.OPEN) this.#send({ type: 'close', reason });
        this.ws?.close();
        this.pc?.close();
    }
}
