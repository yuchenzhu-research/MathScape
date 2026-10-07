const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const DiceMath = require('../engine.js');
const Compute = require('../compute.js');

const bootstrap = `
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const { parentPort, workerData } = require('node:worker_threads');
  global.postMessage = (value, transfer) => parentPort.postMessage(value, transfer);
  global.importScripts = (...files) => files.forEach(file => {
    if (file === 'engine.js') global.DiceMath = require(path.join(workerData.directory, file));
    else vm.runInThisContext(fs.readFileSync(path.join(workerData.directory, file), 'utf8'));
  });
  vm.runInThisContext(fs.readFileSync(path.join(workerData.directory, 'worker.js'), 'utf8'));
  parentPort.on('message', data => global.onmessage({ data }));
`;

function workerFactory(stats = { created: 0, live: 0 }, observeMessage) {
  return function () {
    const thread = new Worker(bootstrap, { eval: true, workerData: { directory: path.resolve(__dirname, '..') } });
    stats.created += 1;
    stats.live += 1;
    const adapter = {
      onmessage: null, onerror: null,
      postMessage(message) { thread.postMessage(message); },
      terminate() { if (!adapter.closed) { adapter.closed = true; stats.live -= 1; thread.terminate(); } }
    };
    thread.on('message', data => {
      if (observeMessage) observeMessage(data);
      if (adapter.onmessage) adapter.onmessage({ data });
    });
    thread.on('error', error => { if (adapter.onerror) adapter.onerror(error); });
    return adapter;
  };
}

function config(overrides = {}) {
  return { probabilities: [0.41, 0.26, 0.17, 0.09, 0.05, 0.02], n: 10, target: 100000, seed: 123456789, workers: 2, computeMode: 'cpu', ...overrides };
}

function reference(configuration) {
  const simulation = DiceMath.createSimulation(DiceMath.normalize(configuration.probabilities), configuration.n, configuration.seed);
  simulation.advance(configuration.target);
  return simulation.snapshot();
}

function equalResult(actual, expected) {
  assert.equal(actual.completed, expected.completed);
  assert.equal(actual.seed, expected.seed);
  for (let i = 0; i < expected.states.length; i += 1) {
    assert.equal(actual.states[i].n, expected.states[i].n);
    assert.deepEqual(Array.from(actual.states[i].counts), Array.from(expected.states[i].counts));
    assert.deepEqual(actual.states[i].dice, expected.states[i].dice);
    assert.equal(actual.states[i].sum, expected.states[i].sum);
    assert.equal(actual.states[i].counts.reduce((a, b) => a + b, 0), expected.completed);
  }
}

function waitFor(controller, predicate, snapshots, timeoutMs = 10000) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    function tick() {
      const found = snapshots.findLast(predicate);
      if (found) { resolve(found); return; }
      if (performance.now() - started > timeoutMs) { controller.dispose(); reject(new Error('Snapshot timeout; latest completed=' + snapshots.at(-1)?.completed)); return; }
      setTimeout(tick, 5);
    }
    tick();
  });
}

test('range offsets reproduce serial stream for every distribution, zero weights and wrapped seed', () => {
  for (const n of [1, 10, 100]) {
    for (const probabilities of [[1, 1, 1, 1, 1, 1], [0, 3, 0, 2, 0, 1], [0, 0, 1, 0, 0, 0]]) {
      const whole = DiceMath.createSimulation(probabilities, n, 4294967295);
      whole.advance(2007);
      const sums = whole.snapshot().states.map(state => new Float64Array(state.counts.length));
      const ranges = [[1874, 133], [0, 301], [301, 1000], [1301, 573]];
      let last;
      for (const [start, amount] of ranges) {
        const part = DiceMath.createSimulation(probabilities, n, 4294967295, start);
        part.advance(amount);
        const snapshot = part.snapshot();
        snapshot.states.forEach((state, i) => state.counts.forEach((value, j) => { sums[i][j] += value; }));
        if (start + amount === 2007) last = snapshot;
      }
      whole.snapshot().states.forEach((state, i) => {
        assert.deepEqual(sums[i], state.counts);
        assert.deepEqual(last.states[i].dice, state.dice);
      });
    }
  }
  assert.throws(() => DiceMath.createSimulation([1, 1, 1, 1, 1, 1], 0, 0));
  assert.throws(() => DiceMath.createSimulation([1, 1, 1, 1, 1, 1], 10, 0, -1));
});

test('actual worker.js ranges produce bit-exact results with one and eight CPU workers', async () => {
  const configuration = config({ target: 131073 });
  const expected = reference(configuration);
  for (const count of [1, 8]) {
    const stats = { created: 0, live: 0 };
    const snapshots = [];
    const controller = Compute.create({ ...configuration, workers: count }, value => snapshots.push(value), { workerFactory: workerFactory(stats), navigator: { hardwareConcurrency: 18 } });
    const final = await controller.done;
    assert.equal(final.phase, 'done');
    assert.equal(final.backend, 'cpu');
    assert.equal(final.workers, count);
    assert.equal(stats.created, count);
    assert.equal(stats.live, 0);
    assert.equal(final.latestGroup, configuration.target);
    equalResult(final, expected);
  }
});

test('paused preparation, single step, resume and slow mode preserve the serial sequence', async () => {
  const snapshots = [];
  const configuration = config({ target: 107, paused: true, slow: true, workers: 4 });
  const controller = Compute.create(configuration, value => snapshots.push(value), { workerFactory: workerFactory(), navigator: { hardwareConcurrency: 18 } });
  await waitFor(controller, value => value.phase === 'paused', snapshots);
  controller.send({ type: 'step' });
  const one = await waitFor(controller, value => value.phase === 'paused' && value.completed === 1, snapshots);
  equalResult(one, reference({ ...configuration, target: 1 }));
  controller.send({ type: 'resume' });
  await waitFor(controller, value => value.completed > 1, snapshots);
  controller.send({ type: 'pause' });
  const paused = await waitFor(controller, value => value.phase === 'paused' && value.completed > 1, snapshots);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(snapshots.at(-1).completed, paused.completed);
  controller.send({ type: 'speed', slow: false });
  controller.send({ type: 'resume' });
  const final = await controller.done;
  equalResult(final, reference(configuration));
});

test('pause drains bounded in-flight batches without losing or duplicating ranges', async () => {
  const configuration = config({ target: 300000, workers: 8 });
  const snapshots = [];
  let asked = false;
  let controller;
  controller = Compute.create(configuration, value => snapshots.push(value), {
    workerFactory: workerFactory(undefined, value => {
      if (!asked && value.type === 'result') { asked = true; controller.send({ type: 'pause' }); }
    }),
    navigator: { hardwareConcurrency: 18 }
  });
  const paused = await waitFor(controller, value => value.phase === 'paused' && value.completed > 0, snapshots);
  assert.ok(paused.completed < configuration.target);
  assert.equal(paused.states[0].counts.reduce((a, b) => a + b, 0), paused.completed);
  controller.send({ type: 'step' });
  const one = await waitFor(controller, value => value.phase === 'paused' && value.completed === paused.completed + 1, snapshots);
  assert.equal(one.completed, paused.completed + 1);
  controller.send({ type: 'resume' });
  equalResult(await controller.done, reference(configuration));
});

test('worker failure retries only uncommitted ranges through the responsive local fallback', async () => {
  const configuration = config({ target: 200000, workers: 2 });
  const factory = workerFactory();
  let injected = false;
  const failingFactory = () => {
    const worker = factory();
    const post = worker.postMessage;
    let jobs = 0;
    worker.postMessage = message => {
      jobs += 1;
      if (!injected && jobs === 2) { injected = true; throw new Error('Injected worker failure'); }
      post(message);
    };
    return worker;
  };
  const controller = Compute.create(configuration, () => {}, { workerFactory: failingFactory, navigator: { hardwareConcurrency: 18 } });
  const final = await controller.done;
  assert.equal(injected, true);
  assert.equal(final.backend, 'local');
  assert.equal(final.info.fallbackReason, 'worker_error');
  equalResult(final, reference(configuration));
});

test('disposal during preparation terminates all created workers and suppresses stale snapshots', async () => {
  const stats = { created: 0, live: 0 };
  const snapshots = [];
  const controller = Compute.create(config({ workers: 8 }), value => snapshots.push(value), { workerFactory: workerFactory(stats), navigator: { hardwareConcurrency: 18 } });
  await new Promise(resolve => setTimeout(resolve, 1));
  controller.dispose();
  const count = snapshots.length;
  assert.equal(await controller.done, null);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(stats.live, 0);
  assert.equal(snapshots.length, count);
});

test('default small run uses multiple workers when the browser exposes spare cores', async () => {
  const stats = { created: 0, live: 0 };
  const controller = Compute.create(config({ workers: 0, target: 1000 }), () => {}, { workerFactory: workerFactory(stats), navigator: { hardwareConcurrency: 18 } });
  const final = await controller.done;
  assert.equal(final.workers, 2);
  assert.equal(stats.created, 2);
  assert.equal(stats.live, 0);
});

test('unsupported GPU has an explicit CPU fallback, never a mislabeled fake GPU', async () => {
  const controller = Compute.create(config({ computeMode: 'gpu', target: 1000 }), () => {}, { workerFactory: workerFactory(), navigator: { hardwareConcurrency: 18 } });
  const final = await controller.done;
  assert.equal(final.backend, 'cpu');
  assert.equal(final.info.fallbackReason, 'gpu_unavailable');
});

test('a GPU adapter with incorrect numeric results is rejected before user sampling', async () => {
  let closed = false;
  const gpuFactory = async () => ({
    name: 'Incorrect test adapter', ready: Promise.resolve(),
    close() { closed = true; },
    async run(configuration, start, count) {
      const simulation = DiceMath.createSimulation(configuration.probabilities, configuration.n, configuration.seed, start);
      simulation.advance(count);
      const value = simulation.snapshot();
      value.states[0].counts[configuration.n] += 1;
      return { ...value, start, end: start + count, computeMs: 1 };
    }
  });
  const configuration = config({ computeMode: 'gpu', target: 1000 });
  const controller = Compute.create(configuration, () => {}, { workerFactory: workerFactory(), gpuFactory, navigator: { hardwareConcurrency: 18 } });
  const final = await controller.done;
  assert.equal(final.backend, 'cpu');
  assert.equal(final.info.fallbackReason, 'gpu_mismatch');
  assert.equal(closed, true);
  equalResult(final, reference(configuration));
});

test('corruption after GPU verification retries the original range through actual CPU workers', async () => {
  let calls = 0;
  const gpuFactory = async () => ({
    name: 'Corrupting test adapter', ready: Promise.resolve(),
    close() {},
    async run(configuration, start, count) {
      calls += 1;
      const simulation = DiceMath.createSimulation(configuration.probabilities, configuration.n, configuration.seed, start);
      simulation.advance(count);
      const value = simulation.snapshot();
      if (calls > 4) value.states[2].counts[2] = NaN;
      return { ...value, start, end: start + count, computeMs: 1 };
    }
  });
  const configuration = config({ computeMode: 'gpu', target: 200000 });
  const stats = { created: 0, live: 0 };
  const controller = Compute.create(configuration, () => {}, { workerFactory: workerFactory(stats), gpuFactory, navigator: { hardwareConcurrency: 18 } });
  const final = await controller.done;
  assert.equal(final.backend, 'cpu');
  assert.equal(final.info.fallbackReason, 'gpu_error');
  assert.equal(stats.created, 2);
  assert.equal(stats.live, 0);
  equalResult(final, reference(configuration));
});

test('file-style fallback can accept a step while it is still preparing', async () => {
  const snapshots = [];
  const configuration = config({ target: 21, paused: true });
  const controller = Compute.create(configuration, value => snapshots.push(value), { workerFactory: null, navigator: {} });
  controller.send({ type: 'step' });
  const stepped = await waitFor(controller, value => value.phase === 'paused' && value.completed === 1, snapshots);
  assert.equal(stepped.backend, 'local');
  controller.send({ type: 'resume' });
  equalResult(await controller.done, reference(configuration));
});

test('automatic CPU routing measures candidates then reuses the configuration-specific profile', async () => {
  const configuration = config({ n: 2, target: 1000000, workers: 0 });
  const stats = { created: 0, live: 0 };
  const dependencies = { workerFactory: workerFactory(stats), navigator: { hardwareConcurrency: 6 } };
  const first = Compute.create(configuration, () => {}, dependencies);
  const final = await first.done;
  assert.equal(final.backend, 'cpu');
  assert.deepEqual(final.info.profile.map(trial => trial.workers), [1, 2, 4]);
  assert.ok(final.info.profile.every(trial => trial.elapsedMs > 0 && trial.groupsPerSecond > 0));
  assert.equal(stats.live, 0);
  equalResult(final, reference(configuration));
  const created = stats.created;
  const second = Compute.create(configuration, () => {}, dependencies);
  const cached = await second.done;
  assert.equal(stats.created - created, final.workers);
  assert.deepEqual(cached.info.profile, final.info.profile);
  equalResult(cached, final);
});

test('explicit recalibration measures worker candidates below the automatic million-group threshold', async () => {
  const configuration = config({ n: 2, target: 100000, workers: 0, recalibrate: true });
  const controller = Compute.create(configuration, () => {}, { workerFactory: workerFactory(), navigator: { hardwareConcurrency: 6 } });
  const final = await controller.done;
  assert.deepEqual(final.info.profile.map(trial => trial.workers), [1, 2, 4]);
  assert.ok(final.info.profile.every(trial => trial.backend === 'cpu' && trial.elapsedMs > 0));
  equalResult(final, reference(configuration));
});

test('recalibration respects manual workers, slow sampling and explicit GPU mode', async () => {
  for (const overrides of [
    { workers: 1, target: 1000 },
    { workers: 0, target: 1, slow: true },
    { workers: 0, target: 1000, computeMode: 'gpu' }
  ]) {
    const configuration = config({ recalibrate: true, ...overrides });
    const controller = Compute.create(configuration, () => {}, { workerFactory: workerFactory(), navigator: { hardwareConcurrency: 6 } });
    const final = await controller.done;
    assert.deepEqual(final.info.profile, []);
    equalResult(final, reference(configuration));
  }
});

test('a failed authorized paused step is retried once, without starting unrequested groups', async t => {
  const configuration = config({ n: 1, target: 10, workers: 1, paused: true });
  const snapshots = [];
  const stats = { created: 0, live: 0 };
  const factory = workerFactory(stats);
  let failed = false;
  const failingFactory = () => {
    const worker = factory();
    const post = worker.postMessage;
    worker.postMessage = message => {
      if (!failed && message.type === 'range') { failed = true; throw new Error('Injected paused-step worker failure'); }
      post(message);
    };
    return worker;
  };
  const controller = Compute.create(configuration, value => snapshots.push(value), { workerFactory: failingFactory, navigator: { hardwareConcurrency: 18 } });
  t.after(() => controller.dispose());
  await waitFor(controller, value => value.phase === 'paused', snapshots);
  controller.send({ type: 'step' });
  const stepped = await waitFor(controller, value => value.phase === 'paused' && value.completed === 1, snapshots, 750);
  assert.equal(stepped.info.fallbackReason, 'worker_error');
  assert.equal(stepped.backend, 'local');
  equalResult(stepped, reference({ ...configuration, target: 1 }));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(snapshots.at(-1).completed, 1);
  controller.send({ type: 'resume' });
  equalResult(await controller.done, reference(configuration));
  assert.equal(stats.live, 0);
});

test('an idle worker fault is remembered before the next authorized paused step', async t => {
  const configuration = config({ n: 1, target: 10, workers: 1, paused: true });
  const snapshots = [];
  const stats = { created: 0, live: 0 };
  const factory = workerFactory(stats);
  let currentWorker;
  let healthyPosts = 0;
  const failingFactory = () => {
    currentWorker = factory();
    const post = currentWorker.postMessage;
    currentWorker.postMessage = message => {
      healthyPosts += 1;
      post(message);
    };
    return currentWorker;
  };
  const controller = Compute.create(configuration, value => snapshots.push(value), { workerFactory: failingFactory, navigator: { hardwareConcurrency: 18 } });
  t.after(() => controller.dispose());
  await waitFor(controller, value => value.phase === 'paused', snapshots);
  currentWorker.onerror({ message: 'Injected idle worker failure' });
  currentWorker.terminate();
  controller.send({ type: 'step' });
  const stepped = await waitFor(controller, value => value.phase === 'paused' && value.completed === 1, snapshots, 750);
  assert.equal(healthyPosts, 0);
  assert.equal(stepped.backend, 'local');
  assert.equal(stepped.info.fallbackReason, 'worker_error');
  equalResult(stepped, reference({ ...configuration, target: 1 }));
  controller.send({ type: 'resume' });
  equalResult(await controller.done, reference(configuration));
  assert.equal(stats.live, 0);
});

test('ordinary failed ranges remain paused until a new step or resume is requested', async t => {
  const configuration = config({ n: 1, target: 10000, workers: 1 });
  const snapshots = [];
  const factory = workerFactory();
  let controller;
  let failed = false;
  const failingFactory = () => {
    const worker = factory();
    const post = worker.postMessage;
    worker.postMessage = message => {
      if (!failed && message.type === 'range') {
        failed = true;
        controller.send({ type: 'pause' });
        throw new Error('Injected ordinary-range failure while pausing');
      }
      post(message);
    };
    return worker;
  };
  controller = Compute.create(configuration, value => snapshots.push(value), { workerFactory: failingFactory, navigator: { hardwareConcurrency: 18 } });
  t.after(() => controller.dispose());
  await waitFor(controller, value => value.phase === 'paused' && value.info.fallbackReason === 'worker_error', snapshots);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(snapshots.at(-1).completed, 0);
  controller.send({ type: 'step' });
  const stepped = await waitFor(controller, value => value.phase === 'paused' && value.completed === 1, snapshots);
  equalResult(stepped, reference({ ...configuration, target: 1 }));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(snapshots.at(-1).completed, 1);
  controller.send({ type: 'resume' });
  equalResult(await controller.done, reference(configuration));
});

module.exports = { workerFactory, config, reference, equalResult };
