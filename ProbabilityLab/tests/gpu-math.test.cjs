const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../engine.js');
const G = require('../gpu.js').numerics;
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const WORD_RANGE = 4294967296;
const STEP = 0x6D2B79F5;

function shaderWord(state) {
  let value = Math.imul(state ^ (state >>> 15), state | 1) >>> 0;
  value = (value ^ ((value + Math.imul(value ^ (value >>> 7), value | 61)) >>> 0)) >>> 0;
  return (value ^ (value >>> 14)) >>> 0;
}

function shaderFace(word, params) {
  for (let index = 0; index < 6; index += 1) {
    if ((params[10] & (1 << index)) || word < params[4 + index]) return index + 1;
  }
  return 6;
}

function shaderReference(config, n, start, count) {
  const params = G.encodeParameters(config, start, count, n);
  const layout = G.layout(n);
  const words = new Uint32Array(layout.outputLength);
  for (let group = 0; group < count; group += 1) {
    for (let index = 0; index < layout.sizes.length; index += 1) {
      const size = layout.sizes[index];
      let state = (config.seed + Math.imul(index, 0x9E3779B9) + Math.imul(Math.imul(start + group, size), STEP)) >>> 0;
      let sum = 0;
      for (let die = 0; die < size; die += 1) {
        state = (state + STEP) >>> 0;
        const value = shaderFace(shaderWord(state), params);
        sum += value;
        if (group === count - 1) words[layout.countsLength + layout.diceOffsets[index] + die] = value;
      }
      words[layout.offsets[index] + sum] += 1;
    }
  }
  return G.decodeResult(words, n, start, count, config.seed, 0);
}

function sequentialReference(config, n, start, count) {
  const cdf = D.cumulative(config.probabilities);
  return [n, 1, 2, 10, 15].map((size, index) => {
    const random = D.seededRandom((config.seed + Math.imul(index, 0x9E3779B9) + Math.imul(start * size, STEP)) >>> 0);
    const counts = new Float64Array(6 * size + 1);
    let dice = [];
    let sum = null;
    for (let group = 0; group < count; group += 1) {
      const next = D.sampleGroup(cdf, size, random);
      counts[next.sum] += 1;
      dice = next.dice;
      sum = next.sum;
    }
    return { n: size, counts, dice, sum };
  });
}

test('GPU integer PRNG matches the existing floating-point interface exactly', () => {
  for (const seed of [0, 1, 42, 0x80000000, 0xffffffff]) {
    const random = D.seededRandom(seed);
    let state = seed >>> 0;
    for (let step = 0; step < 10000; step += 1) {
      state = (state + STEP) >>> 0;
      assert.equal(shaderWord(state), random() * WORD_RANGE);
    }
  }
});

test('GPU threshold encoding handles zero, one and nearly-one CDF values', () => {
  const one = G.encodeParameters({ probabilities: [1, 0, 0, 0, 0, 0], seed: 0 }, 0, 1, 1);
  const six = G.encodeParameters({ probabilities: [0, 0, 0, 0, 0, 1], seed: 0 }, 0, 1, 1);
  assert.equal(one[10], 63);
  assert.equal(six[10], 32);
  const almost = G.encodeParameters({ probabilities: [1, 0, 0, 0, 0, Number.EPSILON], seed: 0 }, 0, 1, 1);
  assert.ok(almost[10] & 1);
  for (const params of [one, six, almost]) {
    const config = params === six ? [0, 0, 0, 0, 0, 1] : params === one ? [1, 0, 0, 0, 0, 0] : [1, 0, 0, 0, 0, Number.EPSILON];
    const cdf = D.cumulative(config);
    for (const word of [0, 1, 0x7fffffff, 0xfffffffe, 0xffffffff]) {
      assert.equal(shaderFace(word, params), D.roll(cdf, () => word / WORD_RANGE));
    }
  }
});

test('GPU face thresholds retain exact strict-less-than comparisons at every boundary', () => {
  for (const probabilities of [[1, 1, 1, 1, 1, 1], [0.4, 0.25, 0.15, 0.1, 0.075, 0.025], [0, 2, 0, 0, 1, 0], [1, 0, 0, 0, 0, 0]]) {
    const cdf = D.cumulative(probabilities);
    const params = G.encodeParameters({ probabilities, seed: 42 }, 7, 19, 10);
    const words = new Set([0, 0xffffffff]);
    cdf.forEach((value) => {
      const threshold = Math.ceil(value * WORD_RANGE);
      for (const word of [threshold - 1, threshold, threshold + 1]) if (word >= 0 && word < WORD_RANGE) words.add(word);
    });
    for (const word of words) assert.equal(shaderFace(word, params), D.roll(cdf, () => word / WORD_RANGE));
  }
});

test('GPU buffer layout has no overlap and supports n=100 within 773 histogram words', () => {
  for (const n of [1, 2, 10, 15, 100]) {
    const layout = G.layout(n);
    assert.equal(layout.offsets[4] + 91, layout.countsLength);
    assert.equal(layout.diceOffsets[4] + 15, n + 28);
    assert.equal(layout.outputLength, layout.countsLength + n + 28);
    assert.ok(layout.countsLength <= 773);
    for (let index = 1; index < 5; index += 1) {
      assert.equal(layout.offsets[index], layout.offsets[index - 1] + 6 * layout.sizes[index - 1] + 1);
      assert.equal(layout.diceOffsets[index], layout.diceOffsets[index - 1] + layout.sizes[index - 1]);
    }
  }
});

test('GPU uint range reference matches CPU sequential states across seeds and large offsets', () => {
  const inputs = [[1, 1, 1, 1, 1, 1], [40, 25, 15, 10, 7.5, 2.5], [1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 1], [0, 2, 0, 0, 1, 0]];
  for (const probabilities of inputs) {
    for (const n of [1, 2, 10, 100]) {
      for (const seed of [0, 42, 0xffffffff]) {
        const config = { probabilities, seed };
        for (const start of [0, 1, 100000003, 0xfffff000]) {
          const result = shaderReference(config, n, start, 129);
          assert.deepEqual(result.states, sequentialReference(config, n, start, 129));
          assert.equal(result.start, start);
          assert.equal(result.end, start + 129);
          assert.equal(result.completed, 129);
          assert.equal(result.seed, seed >>> 0);
          result.states.forEach((state) => assert.equal(Array.from(state.counts).reduce((total, value) => total + value, 0), 129));
        }
      }
    }
  }
});

test('GPU reference preserves original stream from group zero and partitioned ranges', () => {
  const config = { probabilities: [40, 25, 15, 10, 7.5, 2.5], seed: 0xffffffff };
  const cpu = D.createSimulation(config.probabilities, 13, config.seed);
  cpu.advance(513);
  const whole = shaderReference(config, 13, 0, 513);
  assert.deepEqual(whole.states, cpu.snapshot().states);
  const first = shaderReference(config, 13, 0, 257);
  const second = shaderReference(config, 13, 257, 256);
  whole.states.forEach((state, index) => {
    const merged = first.states[index].counts.map((count, bin) => count + second.states[index].counts[bin]);
    assert.deepEqual(merged, state.counts);
    assert.deepEqual(second.states[index].dice, state.dice);
    assert.equal(second.states[index].sum, state.sum);
  });
});

test('GPU zero ranges return empty counts and latest dice, and invalid ranges are rejected', () => {
  const config = { probabilities: [1, 1, 1, 1, 1, 1], seed: 42 };
  const result = shaderReference(config, 1, 25, 0);
  assert.equal(result.completed, 0);
  result.states.forEach((state) => {
    assert.ok(Array.from(state.counts).every((value) => value === 0));
    assert.deepEqual(state.dice, []);
    assert.equal(state.sum, null);
  });
  for (const args of [[-1, 1, 1], [0, -1, 1], [0.5, 1, 1], [0xffffffff, 2, 1], [0, WORD_RANGE, 1], [0, 1, 0], [0, 1, 101]]) {
    assert.throws(() => G.encodeParameters(config, ...args), RangeError);
  }
  assert.throws(() => G.decodeResult(new Uint32Array(2), 1, 0, 1, 42, 0), RangeError);
});

function mockGpu(options = {}) {
  const buffers = [];
  const events = [];
  let releaseMap;
  let mapReady;
  let lostResolve;
  const mapping = new Promise((resolve) => { mapReady = resolve; });
  const device = {
    limits: { maxComputeWorkgroupsPerDimension: 65535 },
    lost: new Promise((resolve) => { lostResolve = resolve; }),
    queue: { writeBuffer() {}, submit() {} },
    createShaderModule() { return { getCompilationInfo: async () => ({ messages: options.badShader ? [{ type: 'error', lineNum: 4, linePos: 2, message: 'mock compile error' }] : [] }) }; },
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    pushErrorScope() {},
    popErrorScope: async () => null,
    createCommandEncoder() {
      return { beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }), copyBufferToBuffer() {}, finish: () => ({}) };
    },
    createBuffer({ size, label }) {
      const buffer = {
        label, size, destroyed: false, mapState: 'unmapped',
        async mapAsync() {
          this.mapState = 'pending';
          mapReady();
          await new Promise((resolve) => { releaseMap = resolve; });
          this.mapState = 'mapped';
        },
        getMappedRange() { return new ArrayBuffer(size); },
        unmap() { events.push('unmap'); this.mapState = 'unmapped'; },
        destroy() { events.push('destroy'); this.destroyed = true; }
      };
      buffers.push(buffer);
      return buffer;
    },
    destroy() { events.push('destroyDevice'); }
  };
  const gpu = options.noGpu ? undefined : {
    requestAdapter: async () => options.noAdapter ? null : { info: { description: 'Mock hardware', isFallbackAdapter: !!options.software }, requestDevice: async () => device }
  };
  const sandbox = {
    DiceMath: D, navigator: { gpu }, fetch: async () => ({ ok: true, text: async () => 'mock shader' }),
    GPUBufferUsage: { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, MAP_READ: 1 }, GPUMapMode: { READ: 1 }, performance: { now: () => 0 }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'gpu.js'), 'utf8'), sandbox);
  return { api: sandbox.ProbabilityGpu, buffers, events, mapping, releaseMap: () => releaseMap(), lose: () => lostResolve({ message: 'mock loss' }) };
}

test('GPU rejects unavailable, missing and software adapters instead of pretending to run on GPU', async () => {
  await assert.rejects(mockGpu({ noGpu: true }).api.create(10), /not available/);
  await assert.rejects(mockGpu({ noAdapter: true }).api.create(10), /No WebGPU adapter/);
  await assert.rejects(mockGpu({ software: true }).api.create(10), /software/);
});

test('GPU shader failures destroy the incomplete device and do not create range buffers', async () => {
  const mock = mockGpu({ badShader: true });
  await assert.rejects(mock.api.create(10), /4:2 mock compile error/);
  assert.deepEqual(mock.events, ['destroyDevice']);
  assert.equal(mock.buffers.length, 0);
});

test('GPU close waits for an in-flight map, unmaps before destroying and is idempotent', async () => {
  const mock = mockGpu();
  const adapter = await mock.api.create(10);
  const result = adapter.run({ probabilities: [1, 1, 1, 1, 1, 1], seed: 42 }, 0, 128);
  await mock.mapping;
  const cleanup = adapter.close();
  assert.equal(adapter.close(), cleanup);
  assert.ok(mock.buffers.every((buffer) => !buffer.destroyed));
  await assert.rejects(adapter.run({ probabilities: [1, 1, 1, 1, 1, 1], seed: 42 }, 0, 1), /closed/);
  mock.releaseMap();
  await result;
  await cleanup;
  assert.deepEqual(mock.events, ['unmap', 'destroy', 'destroy', 'destroy']);
  assert.ok(mock.buffers.every((buffer) => buffer.destroyed));
});

test('GPU rejects oversized ranges and reports device loss explicitly', async () => {
  const mock = mockGpu();
  const adapter = await mock.api.create(10);
  await assert.rejects(adapter.run({ probabilities: [1, 1, 1, 1, 1, 1], seed: 42 }, 0, adapter.maxBatch + 1), /dispatch limit/);
  mock.lose();
  await Promise.resolve();
  await assert.rejects(adapter.run({ probabilities: [1, 1, 1, 1, 1, 1], seed: 42 }, 0, 1), /mock loss/);
  await adapter.close();
});
