import assert from 'node:assert/strict';
import test from 'node:test';

import { TimeSync } from '../time-sync.mjs';

class FakeWebSocket {
    static OPEN = 1;
    static instances = [];
    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
        FakeWebSocket.instances.push(this);
        setTimeout(() => this.onopen?.(), 0);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
    reply(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

// Replaces Date.now with a fixed sequence of return values, restored after use.
function withMockedNow(sequence, fn) {
    const original = Date.now;
    let i = 0;
    Date.now = () => {
        if (i >= sequence.length) throw new Error('Date.now called more times than mocked');
        return sequence[i++];
    };
    return Promise.resolve(fn()).finally(() => {
        Date.now = original;
    });
}

test('calibrate computes offset/rtt per the NTP formula and now() adds the offset', async () => {
    FakeWebSocket.instances.length = 0;
    const sync = new TimeSync({ ppcenter: 'https://center.example', sampleCount: 1, WebSocketImpl: FakeWebSocket });

    // Client clock reads 100ms ahead of ppcenter's truth. Network delay is a
    // symmetric 10ms each way, ppcenter answers instantly (t2 === t3).
    // True send instant = 0 =>  T1(client)=100, T2/T3(server)=10, T4(client)=120.
    // Third value covers calibrate()'s own Date.now() call when it stamps lastSyncAt.
    await withMockedNow([100, 120, 130], async () => {
        const calibrating = sync.calibrate();
        // Let _ensureConnected's setTimeout(0) fire so onopen resolves and the
        // probe actually gets sent before we reply to it.
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(FakeWebSocket.instances.length, 1);
        const ws = FakeWebSocket.instances[0];
        assert.deepEqual(ws.sent[0], { type: 'TIME_SYNC', t1: 100 });
        ws.reply({ type: 'TIME_SYNC_ACK', t1: 100, t2: 10, t3: 10 });
        assert.equal(await calibrating, true);
    });

    // offset = ((10-100)+(10-120))/2 = (-90-110)/2 = -100
    assert.equal(sync.offsetMs, -100);
    // rtt = (120-100)-(10-10) = 20
    assert.equal(sync.lastSyncRttMs, 20);
    assert.equal(sync.isReady(), true);

    // now() must ADD the offset: a later raw reading of 500 corrects to 400,
    // i.e. it removes the client's +100 lead rather than doubling it.
    await withMockedNow([500], () => {
        assert.equal(sync.now(), 400);
    });
});

test('reportLatency sends LATENCY_REPORT only for valid path/delay while connected', async () => {
    FakeWebSocket.instances.length = 0;
    const sync = new TimeSync({ ppcenter: 'https://center.example', WebSocketImpl: FakeWebSocket });
    await sync._ensureConnected();
    const ws = FakeWebSocket.instances[0];

    assert.equal(sync.reportLatency({ path: 'edge', delayMs: 123.6 }), true);
    assert.equal(sync.reportLatency({ path: 'p2p', delayMs: -40 }), true); // negative is valid noise, not rejected
    assert.equal(sync.reportLatency({ path: 'bogus', delayMs: 1 }), false);
    assert.equal(sync.reportLatency({ path: 'edge', delayMs: NaN }), false);

    assert.deepEqual(ws.sent, [
        { type: 'LATENCY_REPORT', path: 'edge', delayMs: 124 },
        { type: 'LATENCY_REPORT', path: 'p2p', delayMs: -40 },
    ]);
});

test('reportLatency is a no-op when not connected', () => {
    const sync = new TimeSync({ ppcenter: 'https://center.example', WebSocketImpl: FakeWebSocket });
    assert.equal(sync.reportLatency({ path: 'edge', delayMs: 10 }), false);
});

test('now() returns null before the first successful calibration', () => {
    const sync = new TimeSync({ ppcenter: 'https://center.example', WebSocketImpl: FakeWebSocket });
    assert.equal(sync.now(), null);
    assert.equal(sync.isReady(), false);
});

test('calibrate keeps the previous offset when every sample in a round fails', async () => {
    // Opens fine (onopen fires) but never reports readyState===OPEN, so
    // _probeOnce's guard rejects synchronously instead of waiting out the
    // 5s probe timeout — keeps this test fast and deterministic.
    class NeverReadySocket extends FakeWebSocket {
        constructor(url) {
            super(url);
            this.readyState = 0;
        }
    }
    const sync = new TimeSync({ ppcenter: 'https://center.example', sampleCount: 1, WebSocketImpl: NeverReadySocket });
    sync.offsetMs = -42; // simulate a previously-successful calibration
    sync.lastSyncRttMs = 7;

    const ok = await sync.calibrate();

    assert.equal(ok, false);
    assert.equal(sync.offsetMs, -42, 'stale offset must survive an all-failed calibration round');
    assert.equal(sync.lastSyncRttMs, 7);
});
