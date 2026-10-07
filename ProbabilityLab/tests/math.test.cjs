const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../engine.js');
const sum = (values) => Array.from(values).reduce((a, b) => a + b, 0);
const close = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' != ' + expected);

test('probabilities normalize and reject invalid inputs', () => {
  close(sum(D.normalize([40, 25, 15, 10, 7.5, 2.5])), 1);
  assert.throws(() => D.normalize([0, 0, 0, 0, 0, 0]), RangeError);
  assert.throws(() => D.normalize([1, 2, 3]), RangeError);
  assert.throws(() => D.normalize([1, 1, -1, 1, 1, 1]), RangeError);
  assert.throws(() => D.normalize([1, 1, NaN, 1, 1, 1]), RangeError);
});

test('one slider redistributes the other five without changing its requested value', () => {
  const original = D.normalize([40, 25, 15, 10, 7.5, 2.5]);
  const edited = D.adjustProbability(original, 0, 0.8);
  close(edited[0], 0.8);
  close(sum(edited), 1);
  close(edited[1] / edited[2], original[1] / original[2]);
  assert.deepEqual(D.adjustProbability(original, 5, 1), [0, 0, 0, 0, 0, 1]);
  const restored = D.adjustProbability([0, 0, 0, 0, 0, 1], 5, 0.5);
  restored.slice(0, 5).forEach((p) => close(p, 0.1));
  close(restored[5], 0.5);
});

test('fair die moments are exact', () => {
  const moments = D.moments([1, 1, 1, 1, 1, 1]);
  close(moments.mean, 3.5);
  close(moments.variance, 35 / 12);
  close(moments.skewness, 0);
});

test('two fair dice have triangular probabilities', () => {
  const distribution = D.exactDistribution([1, 1, 1, 1, 1, 1], 2);
  [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1].forEach((count, index) => close(distribution[index + 2], count / 36));
});

test('convolution preserves probability mass and expected sum through n=100', () => {
  const p = [0.4, 0.25, 0.15, 0.1, 0.075, 0.025];
  for (const n of [1, 2, 10, 15, 100]) {
    const pmf = D.exactDistribution(p, n);
    close(sum(pmf), 1, 1e-12);
    const mean = Array.from(pmf).reduce((total, probability, index) => total + index * probability, 0);
    close(mean, n * D.moments(p).mean, 1e-10);
    assert.ok(Array.from(pmf).every((value) => Number.isFinite(value) && value >= 0));
    assert.equal(pmf.length, n * 6 + 1);
  }
  assert.throws(() => D.exactDistribution(p, 0), RangeError);
  assert.throws(() => D.exactDistribution(p, 101), RangeError);
});

test('deterministic die is a point mass, not a normal distribution', () => {
  const p = [0, 0, 0, 0, 0, 1];
  const pmf = D.exactDistribution(p, 100);
  assert.equal(pmf[600], 1);
  assert.equal(sum(pmf), 1);
  assert.equal(D.moments(p).std, 0);
  assert.equal(D.normalBinMass(599, 600, 600, 0), null);
  const simulation = D.createSimulation(p, 100, 42);
  simulation.advance(20);
  for (const state of simulation.snapshot().states) {
    assert.equal(state.counts[state.n * 6], 20);
    assert.ok(state.dice.every((die) => die === 6));
  }
});

test('normal bin probability uses continuity correction', () => {
  close(D.normalCDF(0, 0, 1), 0.5, 1e-8);
  close(D.normalCDF(1.96, 0, 1), 0.9750021, 1e-6);
  close(D.normalCDF(-1.96, 0, 1), 0.0249979, 1e-6);
  close(D.normalBinMass(0, 0, 0, 1), 0.3829249, 1e-6);
  assert.equal(D.normalCDF(-20, 0, 1), 0);
  assert.equal(D.normalCDF(20, 0, 1), 1);
});

test('chart binning preserves mass and all counts', () => {
  const pmf = D.exactDistribution([1, 1, 1, 1, 1, 1], 100);
  const counts = new Float64Array(601);
  counts[100] = 5;
  counts[350] = 30;
  counts[600] = 7;
  const binned = D.binDistribution(pmf, counts, 100, 30);
  close(binned.bins.reduce((total, bin) => total + bin.probability, 0), 1, 1e-12);
  assert.equal(binned.bins.reduce((total, bin) => total + bin.count, 0), 42);
  assert.ok(binned.bins.length <= 30);
});

test('seeded results do not depend on batch sizes or snapshots', () => {
  const p = [0.4, 0.25, 0.15, 0.1, 0.075, 0.025];
  const single = D.createSimulation(p, 13, 4294967295);
  const batches = D.createSimulation(p, 13, 4294967295);
  single.advance(3000);
  batches.advance(117);
  batches.snapshot();
  batches.advance(1883);
  batches.advance(1000);
  assert.deepEqual(single.snapshot(), batches.snapshot());
  assert.ok(single.snapshot().states.every((state) => sum(state.counts) === 3000));
});

test('large Monte Carlo experiment matches configured expectation', () => {
  const p = [0.4, 0.25, 0.15, 0.1, 0.075, 0.025];
  const simulation = D.createSimulation(p, 10, 42);
  simulation.advance(1000000);
  const result = simulation.snapshot();
  assert.equal(result.completed, 1000000);
  result.states.forEach((state) => {
    assert.equal(sum(state.counts), 1000000);
    const empirical = D.empiricalMoments(state.counts);
    close(empirical.mean, D.moments(p).mean * state.n, 0.025);
  });
});

test('zero samples and zero-size batch are handled without NaN', () => {
  const simulation = D.createSimulation([1, 1, 1, 1, 1, 1], 1, 42);
  simulation.advance(0);
  assert.equal(simulation.snapshot().completed, 0);
  assert.deepEqual(D.empiricalMoments(simulation.snapshot().states[0].counts), { mean: null, variance: null, total: 0 });
  assert.throws(() => simulation.advance(-1), RangeError);
});
