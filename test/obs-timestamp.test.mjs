import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidObsTimestampMessage, computeDelayMs } from '../obs-timestamp.mjs';

test('isValidObsTimestampMessage accepts a well-formed obs-timestamp payload', () => {
    assert.equal(isValidObsTimestampMessage({ frame_no: 1234, timestamp: 1733500000123, rid: '0' }), true);
});

test('isValidObsTimestampMessage rejects malformed shapes', () => {
    assert.equal(isValidObsTimestampMessage(null), false);
    assert.equal(isValidObsTimestampMessage({ frame_no: 1234, rid: '0' }), false); // missing timestamp
    assert.equal(isValidObsTimestampMessage({ frame_no: '1234', timestamp: 1, rid: '0' }), false); // frame_no not an int
    assert.equal(isValidObsTimestampMessage({ frame_no: 1, timestamp: 1, rid: 0 }), false); // rid not a string
});

test('computeDelayMs is null before calibration and a plain subtraction after', () => {
    assert.equal(computeDelayMs(null, 1000), null);
    assert.equal(computeDelayMs(undefined, 1000), null);
    assert.equal(computeDelayMs(1500, 1000), 500);
    assert.equal(computeDelayMs(900, 1000), -100); // occasional small negative is expected noise, not clamped here
});
