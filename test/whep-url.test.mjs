import assert from 'node:assert/strict';
import test from 'node:test';

import { isWhepUrl, looksLikeUrl, WHEP_ONLY_MESSAGE } from '../whep-url.mjs';

test('accepts WHEP URLs with and without a codec segment', () => {
    assert.equal(isWhepUrl('https://edge-1.edge.pp-cdn.org/app1/B01-front/whep'), true);
    assert.equal(isWhepUrl('https://edge-1.edge.pp-cdn.org/app1/B01-front/h264/whep'), true);
    assert.equal(isWhepUrl('http://203.0.113.10:8888/app1/B01-front/hevc/whep?txTime=1&txSecret=v1.default.ab'), true);
    assert.equal(isWhepUrl('  https://edge.example/app1/B01-front/whep  '), true);
});

test('rejects other pull formats', () => {
    for (const url of [
        'https://cdn.example/live/app1/B01-front.m3u8',
        'https://cdn.example/live/app1/B01-front.flv',
        'rtmp://cdn.example/live/B01-front',
        'srt://cdn.example:7890?streamid=read:app1/B01-front',
        'rtsp://cdn.example/app1/B01-front',
        'webrtc://cdn.example/app1/B01-front',
        'https://edge.example/app1/B01-front',
        'https://edge.example/whep',
        'https://edge.example/app1/whep',
    ]) {
        assert.equal(isWhepUrl(url), false, url);
    }
});

test('rejects garbage without throwing', () => {
    for (const bad of ['', '   ', null, undefined, 'not a url', '/app1/B01-front/whep']) {
        assert.equal(isWhepUrl(bad), false, String(bad));
    }
});

test('looksLikeUrl tells URLs from appId/streamName', () => {
    assert.equal(looksLikeUrl('https://edge.example/app1/s/whep'), true);
    assert.equal(looksLikeUrl('rtmp://h/app/s'), true);
    assert.equal(looksLikeUrl('app1/B01-front'), false);
    assert.equal(looksLikeUrl('app1/B01-front/hevc'), false);
    assert.equal(looksLikeUrl(''), false);
});

test('the notice is plain text that is safe for innerHTML', () => {
    assert.match(WHEP_ONLY_MESSAGE, /WHEP/);
    assert.doesNotMatch(WHEP_ONLY_MESSAGE, /[<>&]/);
});
