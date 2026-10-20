import assert from 'node:assert/strict';
import test from 'node:test';

import { attachPassthroughTransform } from '../sei-timestamp.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('returns false when the receiver has no createEncodedStreams', () => {
    assert.equal(attachPassthroughTransform(null), false);
    assert.equal(attachPassthroughTransform({}), false);
});

test('forwards every encoded frame unchanged', async () => {
    const frame = { data: new Uint8Array([1, 2, 3]).buffer, metadata: 'frame-1' };
    const written = [];
    const receiver = {
        createEncodedStreams() {
            return {
                readable: new ReadableStream({
                    start(controller) {
                        controller.enqueue(frame);
                        controller.close();
                    }
                }),
                writable: new WritableStream({
                    write(value) {
                        written.push(value);
                    }
                })
            };
        }
    };

    assert.equal(attachPassthroughTransform(receiver), true);
    await flush();
    await flush();

    assert.equal(written.length, 1);
    assert.equal(written[0], frame, 'the same frame object must reach the writable side');
});
