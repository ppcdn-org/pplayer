import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBufferMs, clampBufferMs, bufferMsToPlayoutDelaySeconds, applyPlayoutBuffer, MIN_BUFFER_MS, MAX_BUFFER_MS, DEFAULT_BUFFER_MS } from '../buffer-config.mjs';

test('parseBufferMs returns null when no value was supplied', () => {
    assert.equal(parseBufferMs(null), null);
    assert.equal(parseBufferMs(undefined), null);
    assert.equal(parseBufferMs(''), null);
});

test('parseBufferMs returns null for non-numeric input instead of guessing a default', () => {
    assert.equal(parseBufferMs('fast'), null);
    assert.equal(parseBufferMs('NaN'), null);
});

test('parseBufferMs clamps values below the supported minimum', () => {
    assert.equal(parseBufferMs('0'), MIN_BUFFER_MS);
    assert.equal(parseBufferMs('-500'), MIN_BUFFER_MS);
    assert.equal(parseBufferMs('50'), MIN_BUFFER_MS);
});

test('parseBufferMs clamps values above the supported maximum', () => {
    assert.equal(parseBufferMs('5000'), MAX_BUFFER_MS);
});

test('parseBufferMs passes through in-range values unchanged', () => {
    assert.equal(parseBufferMs('500'), 500);
    assert.equal(parseBufferMs('100'), 100);
    assert.equal(parseBufferMs('1000'), 1000);
});

test('clampBufferMs clamps a raw number the same way', () => {
    assert.equal(clampBufferMs(50), MIN_BUFFER_MS);
    assert.equal(clampBufferMs(1500), MAX_BUFFER_MS);
    assert.equal(clampBufferMs(750), 750);
});

test('bufferMsToPlayoutDelaySeconds converts ms to the seconds unit RTCRtpReceiver expects', () => {
    assert.equal(bufferMsToPlayoutDelaySeconds(500), 0.5);
    assert.equal(bufferMsToPlayoutDelaySeconds(100), 0.1);
    assert.equal(bufferMsToPlayoutDelaySeconds(1000), 1);
});

// A minimal RTCPeerConnection stand-in: applyPlayoutBuffer only ever calls
// getReceivers() and assigns to whichever property a receiver exposes.
function fakePc(receivers) {
    return { getReceivers: () => receivers };
}

test('applyPlayoutBuffer prefers the standardized jitterBufferTarget, in milliseconds', () => {
    const receiver = { jitterBufferTarget: null };
    assert.equal(applyPlayoutBuffer(fakePc([receiver]), 400), 'jitterBufferTarget');
    assert.equal(receiver.jitterBufferTarget, 400);
});

test('applyPlayoutBuffer falls back to playoutDelayHint, converted to seconds', () => {
    const receiver = { playoutDelayHint: null };
    assert.equal(applyPlayoutBuffer(fakePc([receiver]), 400), 'playoutDelayHint');
    assert.equal(receiver.playoutDelayHint, 0.4);
});

test('applyPlayoutBuffer sets every receiver, not just the first', () => {
    const video = { jitterBufferTarget: null };
    const audio = { jitterBufferTarget: null };
    applyPlayoutBuffer(fakePc([video, audio]), 300);
    assert.equal(video.jitterBufferTarget, 300);
    assert.equal(audio.jitterBufferTarget, 300);
});

test('applyPlayoutBuffer clamps before assigning, so the receiver never sees an out-of-range value', () => {
    const receiver = { jitterBufferTarget: null };
    applyPlayoutBuffer(fakePc([receiver]), 99999);
    assert.equal(receiver.jitterBufferTarget, MAX_BUFFER_MS);
});

test('applyPlayoutBuffer reports null when the browser exposes neither API', () => {
    // Distinguishing this from a successful apply is the whole point: the UI
    // greys the control out rather than pretending the setting took effect.
    assert.equal(applyPlayoutBuffer(fakePc([{}]), 400), null);
});

test('applyPlayoutBuffer reports null when no track has arrived yet', () => {
    assert.equal(applyPlayoutBuffer(fakePc([]), 400), null);
});

test('applyPlayoutBuffer tolerates a missing or half-built peer connection', () => {
    assert.equal(applyPlayoutBuffer(null, 400), null);
    assert.equal(applyPlayoutBuffer(undefined, 400), null);
    assert.equal(applyPlayoutBuffer({}, 400), null);
});

test('DEFAULT_BUFFER_MS sits inside the supported range', () => {
    assert.equal(DEFAULT_BUFFER_MS, 200);
    assert.ok(DEFAULT_BUFFER_MS >= MIN_BUFFER_MS && DEFAULT_BUFFER_MS <= MAX_BUFFER_MS);
});
