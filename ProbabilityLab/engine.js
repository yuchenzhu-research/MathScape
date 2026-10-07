(function (root) {
  'use strict';

  function normalize(weights) {
    if (weights.length !== 6 || weights.some(function (v) { return !Number.isFinite(v) || v < 0; })) {
      throw new RangeError('Six nonnegative, finite weights are required');
    }
    var total = weights.reduce(function (a, b) { return a + b; }, 0);
    if (total <= 0) throw new RangeError('At least one probability must be positive');
    return weights.map(function (v) { return v / total; });
  }

  function adjustProbability(probabilities, index, value) {
    if (!Number.isInteger(index) || index < 0 || index > 5 || !Number.isFinite(value)) throw new RangeError('Invalid probability edit');
    var p = normalize(probabilities);
    var target = Math.max(0, Math.min(1, value));
    var other = p.reduce(function (sum, v, i) { return sum + (i === index ? 0 : v); }, 0);
    return p.map(function (v, i) { return i === index ? target : (other > 1e-14 ? v / other : 0.2) * (1 - target); });
  }

  function moments(probabilities) {
    var p = normalize(probabilities);
    var mean = p.reduce(function (sum, v, i) { return sum + v * (i + 1); }, 0);
    var variance = p.reduce(function (sum, v, i) { return sum + v * Math.pow(i + 1 - mean, 2); }, 0);
    var third = p.reduce(function (sum, v, i) { return sum + v * Math.pow(i + 1 - mean, 3); }, 0);
    return { mean: mean, variance: variance, std: Math.sqrt(variance), skewness: variance > 0 ? third / Math.pow(variance, 1.5) : 0 };
  }

  function exactDistribution(probabilities, n) {
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new RangeError('Group size must be an integer between 1 and 100');
    var p = normalize(probabilities);
    var previous = new Float64Array(1);
    previous[0] = 1;
    for (var k = 0; k < n; k += 1) {
      var next = new Float64Array(previous.length + 6);
      for (var s = 0; s < previous.length; s += 1) {
        if (previous[s] === 0) continue;
        for (var face = 1; face <= 6; face += 1) next[s + face] += previous[s] * p[face - 1];
      }
      previous = next;
    }
    return previous;
  }

  function cumulative(probabilities) {
    var p = normalize(probabilities);
    var sum = 0;
    return p.map(function (v, i) { sum += v; return i === 5 ? 1 : sum; });
  }

  function roll(cdf, random) {
    var u = random();
    for (var i = 0; i < 6; i += 1) if (u < cdf[i]) return i + 1;
    return 6;
  }

  function sampleGroup(cdf, n, random) {
    var dice = new Array(n);
    var sum = 0;
    for (var i = 0; i < n; i += 1) { dice[i] = roll(cdf, random); sum += dice[i]; }
    return { dice: dice, sum: sum };
  }

  function seededRandom(seed) {
    var state = seed >>> 0;
    return function () {
      state = (state + 0x6D2B79F5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function normalCDF(x, mean, std) {
    if (!(std > 0)) return x < mean ? 0 : 1;
    var z = (x - mean) / std;
    if (z <= -9) return 0;
    if (z >= 9) return 1;
    var a = Math.abs(z) / Math.SQRT2;
    var t = 1 / (1 + 0.3275911 * a);
    var erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
    return 0.5 * (1 + (z < 0 ? -erf : erf));
  }

  function normalBinMass(start, end, mean, std) {
    if (!(std > 0)) return null;
    return Math.max(0, normalCDF(end + 0.5, mean, std) - normalCDF(start - 0.5, mean, std));
  }

  function binDistribution(pmf, counts, n, maxBins, range) {
    var lower = range ? range[0] : n;
    var upper = range ? range[1] : 6 * n;
    var width = Math.max(1, Math.ceil((upper - lower + 1) / Math.max(1, maxBins)));
    var bins = [];
    for (var start = lower; start <= upper; start += width) {
      var end = Math.min(upper, start + width - 1);
      var probability = 0;
      var count = 0;
      for (var i = start; i <= end; i += 1) { probability += pmf[i] || 0; count += counts[i] || 0; }
      bins.push({ start: start, end: end, center: (start + end) / 2, probability: probability, count: count });
    }
    return { bins: bins, width: width };
  }

  function createSimulation(probabilities, n, seed, startGroup) {
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new RangeError('Group size must be an integer between 1 and 100');
    startGroup = startGroup === undefined ? 0 : startGroup;
    if (!Number.isSafeInteger(startGroup) || startGroup < 0 || startGroup > 100000000) throw new RangeError('Invalid group offset');
    var cdf = cumulative(probabilities);
    var sizes = [n, 1, 2, 10, 15];
    var states = sizes.map(function (size, index) {
      var rangeSeed = (seed + Math.imul(index, 0x9E3779B9) + Math.imul(startGroup * size, 0x6D2B79F5)) >>> 0;
      return { n: size, counts: new Float64Array(6 * size + 1), random: seededRandom(rangeSeed), dice: [], sum: null };
    });
    var completed = 0;
    return {
      advance: function (groups) {
        if (!Number.isInteger(groups) || groups < 0) throw new RangeError('Invalid batch size');
        if (groups === 0) return;
        for (var k = 0; k < states.length; k += 1) {
          var state = states[k];
          for (var g = 0; g < groups; g += 1) {
            var sum = 0;
            var latest = g === groups - 1;
            if (latest) state.dice = new Array(state.n);
            for (var d = 0; d < state.n; d += 1) {
              var value = roll(cdf, state.random);
              sum += value;
              if (latest) state.dice[d] = value;
            }
            state.counts[sum] += 1;
            if (latest) state.sum = sum;
          }
        }
        completed += groups;
      },
      snapshot: function () {
        return { completed: completed, seed: seed >>> 0, states: states.map(function (state) {
          return { n: state.n, counts: state.counts.slice(), dice: state.dice.slice(), sum: state.sum };
        }) };
      }
    };
  }

  function empiricalMoments(counts) {
    var total = 0;
    var weighted = 0;
    for (var i = 0; i < counts.length; i += 1) { total += counts[i]; weighted += i * counts[i]; }
    if (total === 0) return { mean: null, variance: null, total: 0 };
    var mean = weighted / total;
    var variance = 0;
    for (var j = 0; j < counts.length; j += 1) variance += counts[j] * Math.pow(j - mean, 2) / total;
    return { mean: mean, variance: variance, total: total };
  }

  var api = { normalize: normalize, adjustProbability: adjustProbability, moments: moments, exactDistribution: exactDistribution, cumulative: cumulative, roll: roll, sampleGroup: sampleGroup, seededRandom: seededRandom, normalCDF: normalCDF, normalBinMass: normalBinMass, binDistribution: binDistribution, createSimulation: createSimulation, empiricalMoments: empiricalMoments };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DiceMath = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
