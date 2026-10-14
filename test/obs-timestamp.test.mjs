import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidObsTimestampMessage, computeDelayMs } from '../obs-timestamp.mjs';

test('isValidObsTimestampMessage accepts a well-formed obs-timestamp payload', () => {
    assert.equal(isValidObsTimestampMessage({ timestamp: 1733500000123 }), true);
});

test('isValidObsTimestampMessage rejects malformed shapes', () => {
    assert.equal(isValidObsTimestampMessage(null), false);
    assert.equal(isValidObsTimestampMessage({}), false); // missing timestamp
    assert.equal(isValidObsTimestampMessage({ timestamp: 'not-a-number' }), false); // timestamp not numeric
    assert.equal(isValidObsTimestampMessage({ timestamp: 0 }), false); // timestamp not positive
    assert.equal(isValidObsTimestampMessage({ timestamp: -1 }), false); // timestamp not positive
});

test('computeDelayMs is null before calibration and a plain subtraction after', () => {
    assert.equal(computeDelayMs(null, 1000), null);
    assert.equal(computeDelayMs(undefined, 1000), null);
    assert.equal(computeDelayMs(1500, 1000), 500);
    assert.equal(computeDelayMs(900, 1000), -100); // occasional small negative is expected noise, not clamped here
});
