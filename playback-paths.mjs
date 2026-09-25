import { applyPlayoutBuffer } from './buffer-config.mjs?v=20260924-8';
import { MediaMTXWebRTCReader } from './ppplayer.mjs?v=20260924-8';

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

export class EdgeWHEPPath {
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

export class P2PPlaybackPath {
    constructor({ session, WebSocketClass = globalThis.WebSocket, PeerConnectionClass = globalThis.RTCPeerConnection, bufferMs = null }) {
        this.session = session;
        this.WebSocketClass = WebSocketClass;
        this.PeerConnectionClass = PeerConnectionClass;
        this.bufferMs = bufferMs;
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
        this.pc = new this.PeerConnectionClass(iceConfig);
        this.onSignal?.({ type: 'pc-created', iceServers: (iceConfig?.iceServers ?? []).map((s) => s.urls) });
        this.pc.addTransceiver('video', { direction: 'recvonly' });
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
