
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

export { ABREngine };
