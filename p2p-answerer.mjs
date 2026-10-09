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
import { preferH264 } from './ppwebpublish.mjs';

export class P2PAnswerer {
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

        // Send the publisher's media on this PC. One sendonly transceiver per
        // captured track; video is pinned to H264 to match the viewer's offer.
        for (const track of this.mediaStream.getTracks()) {
            const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [this.mediaStream] });
            if (track.kind === 'video') preferH264(transceiver);
        }
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

        await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        for (const candidate of entry.pendingCandidates) await pc.addIceCandidate(candidate);
        entry.pendingCandidates = [];
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
