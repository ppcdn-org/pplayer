import assert from 'node:assert/strict';
import test from 'node:test';

import { PlaybackRaceController } from '../playback-race-controller.mjs';

class FakeClock {
    constructor() {
        this.time = 0;
        this.nextId = 1;
        this.timers = new Map();
    }

    now = () => this.time;

    setTimeout = (callback, delay) => {
        const id = this.nextId++;
        this.timers.set(id, { at: this.time + delay, callback });
        return id;
    };

    clearTimeout = (id) => {
        this.timers.delete(id);
    };

    advance(ms) {
        const target = this.time + ms;
        while (true) {
            const due = [...this.timers.entries()]
                .filter(([, timer]) => timer.at <= target)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!due) {
                break;
            }
            this.time = due[1].at;
            this.timers.delete(due[0]);
            due[1].callback();
        }
        this.time = target;
    }
}

class FakePath {
    starts = 0;
    stops = [];
    callbacks = null;

    start(callbacks) {
        this.starts++;
        this.callbacks = callbacks;
    }

    stop(reason) {
        this.stops.push(reason);
    }

    frame(info = {}) {
        this.callbacks.onFirstFrame(info);
    }

    fail(error = new Error('failed')) {
        this.callbacks.onFailed(error);
    }
}

function setup(options = {}) {
    const clock = new FakeClock();
    const edgePath = new FakePath();
    const p2pPath = new FakePath();
    const selections = [];
    const failures = [];
    const telemetry = [];
    const controller = new PlaybackRaceController({
        edgePath,
        p2pPath,
        clock,
        onSelected: (selection) => selections.push(selection),
        onFailed: (error) => failures.push(error),
        onTelemetry: (event) => telemetry.push(event),
        ...options,
    });
    return { controller, clock, edgePath, p2pPath, selections, failures, telemetry };
}

test('starts Edge and P2P without awaiting either path', () => {
    const context = setup();
    context.controller.start();

    assert.equal(context.edgePath.starts, 1);
    assert.equal(context.p2pPath.starts, 1);
    assert.equal(context.controller.getState().state, 'racing');
});

test('selects P2P when it produces the first frame within 500ms', () => {
    const context = setup();
    context.controller.start();
    context.clock.advance(499);
    context.p2pPath.frame({ timestamp: 100 });

    assert.equal(context.controller.getState().selectedPath, 'p2p');
    assert.deepEqual(context.edgePath.stops, ['p2p_selected']);
    assert.equal(context.selections.length, 1);
});

test('selects Edge immediately and keeps background P2P alive', () => {
    const context = setup();
    context.controller.start();
    context.clock.advance(100);
    context.edgePath.frame();

    assert.equal(context.controller.getState().selectedPath, 'edge');
    assert.deepEqual(context.p2pPath.stops, []);
});

test('continues racing when neither path has a frame at 500ms', () => {
    const context = setup();
    context.controller.start();
    context.clock.advance(500);

    const state = context.controller.getState();
    assert.equal(state.state, 'racing');
    assert.equal(state.raceWindowElapsed, true);

    context.clock.advance(100);
    context.p2pPath.frame();
    assert.equal(context.controller.getState().selectedPath, 'p2p');
});

test('rejects late P2P switching by default', () => {
    const context = setup();
    context.controller.start();
    context.edgePath.frame();
    context.clock.advance(700);
    context.p2pPath.frame();

    assert.equal(context.controller.getState().selectedPath, 'edge');
    assert.deepEqual(context.p2pPath.stops, ['late_switch_rejected']);
});

test('switches from Edge to late P2P when policy accepts it', () => {
    const context = setup({ canSwitchToP2P: () => true });
    context.controller.start();
    context.edgePath.frame();
    context.clock.advance(700);
    context.p2pPath.frame();

    assert.equal(context.controller.getState().selectedPath, 'p2p');
    assert.deepEqual(context.edgePath.stops, ['p2p_selected']);
    assert.equal(context.selections.length, 2);
    assert.equal(context.selections[1].reason, 'late_p2p_switch');
});

test('times out background P2P without affecting selected Edge', () => {
    const context = setup();
    context.controller.start();
    context.edgePath.frame();
    context.clock.advance(2000);

    assert.equal(context.controller.getState().selectedPath, 'edge');
    assert.deepEqual(context.p2pPath.stops, ['connect_timeout']);
    assert.equal(context.failures.length, 0);
});

test('P2P failure never stops Edge', () => {
    const context = setup();
    context.controller.start();
    context.p2pPath.fail();
    context.edgePath.frame();

    assert.equal(context.controller.getState().selectedPath, 'edge');
    assert.deepEqual(context.edgePath.stops, []);
});

test('restarts Edge when selected P2P later fails', () => {
    const context = setup();
    context.controller.start();
    context.p2pPath.frame();
    context.p2pPath.fail(new Error('connection lost'));

    assert.equal(context.controller.getState().state, 'reconnecting_edge');
    assert.equal(context.edgePath.starts, 2);

    context.edgePath.frame();
    assert.equal(context.controller.getState().selectedPath, 'edge');
    assert.equal(context.selections.at(-1).reason, 'first_frame');
});

test('reports failure once when both paths are unavailable', () => {
    const context = setup();
    context.controller.start();
    context.edgePath.fail();
    context.p2pPath.fail();
    context.p2pPath.fail();

    assert.equal(context.controller.getState().state, 'failed');
    assert.equal(context.failures.length, 1);
});

test('stop is idempotent and ignores late callbacks', () => {
    const context = setup();
    context.controller.start();
    context.controller.stop();
    context.controller.stop();
    context.edgePath.frame();
    context.p2pPath.fail();

    assert.deepEqual(context.edgePath.stops, ['player_stopped']);
    assert.deepEqual(context.p2pPath.stops, ['player_stopped']);
    assert.equal(context.controller.getState().state, 'stopped');
    assert.equal(context.selections.length, 0);
    assert.equal(context.failures.length, 0);
});

test('emits timing and final route telemetry', () => {
    const context = setup();
    context.controller.start();
    context.clock.advance(120);
    context.edgePath.frame();

    const firstFrame = context.telemetry.find((entry) => entry.event === 'path_first_frame');
    const selected = context.telemetry.find((entry) => entry.event === 'path_selected');
    assert.equal(firstFrame.path, 'edge');
    assert.equal(firstFrame.elapsedMs, 120);
    assert.equal(selected.path, 'edge');
});
