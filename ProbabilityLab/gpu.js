(function (root) {
  'use strict';

  var DiceMath = root.DiceMath || (typeof module !== 'undefined' && module.exports ? require('./engine.js') : null);
  var UINT_RANGE = 4294967296;
  var WORKGROUP_SIZE = 128;
  var cachedContext = null;

  function groupSize(n) {
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new RangeError('GPU group size must be an integer between 1 and 100');
    return n;
  }

  function encodeParameters(config, start, count, n) {
    groupSize(n);
    if (!Number.isInteger(start) || start < 0 || start >= UINT_RANGE || !Number.isInteger(count) || count < 0 || count >= UINT_RANGE || start + count > UINT_RANGE) {
      throw new RangeError('GPU ranges must fit within the unsigned 32-bit group index');
    }
    var cdf = DiceMath.cumulative(config.probabilities);
    var params = new Uint32Array(11);
    params.set([start, count, n, config.seed >>> 0]);
    cdf.forEach(function (value, index) {
      var threshold = Math.ceil(value * UINT_RANGE);
      if (threshold >= UINT_RANGE) params[10] |= 1 << index;
      else params[4 + index] = threshold;
    });
    return params;
  }

  function layout(n) {
    groupSize(n);
    var countsLength = 6 * n + 173;
    var sizes = [n, 1, 2, 10, 15];
    var offsets = [0, 6 * n + 1, 6 * n + 8, 6 * n + 21, 6 * n + 82];
    var diceOffsets = [0, n, n + 1, n + 3, n + 13];
    return { countsLength: countsLength, sizes: sizes, offsets: offsets, diceOffsets: diceOffsets, outputLength: countsLength + n + 28 };
  }

  function decodeResult(raw, n, start, count, seed, computeMs) {
    var description = layout(n);
    if (raw.length !== description.outputLength) throw new RangeError('Unexpected GPU result buffer length');
    return {
      start: start,
      end: start + count,
      completed: count,
      seed: seed >>> 0,
      computeMs: computeMs,
      states: description.sizes.map(function (size, index) {
        var counts = new Float64Array(6 * size + 1);
        counts.set(raw.subarray(description.offsets[index], description.offsets[index] + counts.length));
        var dice = count ? Array.from(raw.subarray(description.countsLength + description.diceOffsets[index], description.countsLength + description.diceOffsets[index] + size)) : [];
        return { n: size, counts: counts, dice: dice, sum: count ? dice.reduce(function (total, value) { return total + value; }, 0) : null };
      })
    };
  }

  async function initializeContext() {
    if (!root.navigator || !root.navigator.gpu) throw new Error('WebGPU is not available in this browser');
    var adapter = await root.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available');
    var info = adapter.info || {};
    if (info.isFallbackAdapter === true || adapter.isFallbackAdapter === true) throw new Error('Only a software WebGPU adapter is available');
    var device = await adapter.requestDevice();
    try {
      var response = await root.fetch('dice.wgsl');
      if (!response.ok) throw new Error('The GPU shader could not be loaded (' + response.status + ')');
      var source = await response.text();
      var shader = device.createShaderModule({ label: 'ProbabilityLab exact integer Monte Carlo', code: source });
      if (typeof shader.getCompilationInfo === 'function') {
        var compilation = await shader.getCompilationInfo();
        var errors = compilation.messages.filter(function (message) { return message.type === 'error'; });
        if (errors.length) throw new Error('GPU shader compilation failed: ' + errors.map(function (message) { return message.lineNum + ':' + message.linePos + ' ' + message.message; }).join('; '));
      }
      device.pushErrorScope('validation');
      var pipeline;
      var pipelineError;
      try {
        pipeline = await device.createComputePipelineAsync({ label: 'ProbabilityLab Monte Carlo', layout: 'auto', compute: { module: shader, entryPoint: 'simulate' } });
      } finally {
        pipelineError = await device.popErrorScope();
      }
      if (pipelineError) throw new Error('GPU pipeline validation failed: ' + pipelineError.message);
      var context = {
        device: device,
        pipeline: pipeline,
        name: info.description || [info.vendor, info.architecture, info.device].filter(Boolean).join(' ') || 'WebGPU',
        maxBatch: Math.min(device.limits.maxComputeWorkgroupsPerDimension * WORKGROUP_SIZE, 1048576),
        lost: null,
        queue: Promise.resolve()
      };
      device.lost.then(function (loss) {
        context.lost = loss.message || loss.reason || 'device lost';
        if (cachedContext) cachedContext.then(function (active) { if (active === context) cachedContext = null; }, function () {});
      });
      return context;
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  function getContext() {
    if (!cachedContext) {
      var request = initializeContext();
      cachedContext = request;
      request.catch(function () { if (cachedContext === request) cachedContext = null; });
    }
    return cachedContext;
  }

  async function create(n) {
    groupSize(n);
    var context = await getContext();
    if (context.lost) throw new Error('WebGPU device lost: ' + context.lost);
    var device = context.device;
    var description = layout(n);
    var bufferBytes = description.outputLength * Uint32Array.BYTES_PER_ELEMENT;
    var usage = root.GPUBufferUsage;
    var mapMode = root.GPUMapMode;
    var paramsBuffer = device.createBuffer({ label: 'ProbabilityLab GPU parameters', size: 44, usage: usage.STORAGE | usage.COPY_DST });
    var outputBuffer = device.createBuffer({ label: 'ProbabilityLab GPU histograms', size: bufferBytes, usage: usage.STORAGE | usage.COPY_SRC | usage.COPY_DST });
    var readBuffer = device.createBuffer({ label: 'ProbabilityLab GPU readback', size: bufferBytes, usage: usage.MAP_READ | usage.COPY_DST });
    var clearValues = new Uint32Array(description.outputLength);
    var bindings = device.createBindGroup({ layout: context.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: { buffer: outputBuffer } }
    ] });
    var closed = false;
    var pending = Promise.resolve();
    var cleanup = null;

    async function execute(config, start, count) {
      if (closed) throw new Error('GPU adapter is closed');
      if (context.lost) throw new Error('WebGPU device lost: ' + context.lost);
      var parameters = encodeParameters(config, start, count, n);
      if (count > context.maxBatch) throw new RangeError('GPU batch exceeds the device dispatch limit');
      if (!count) return decodeResult(clearValues, n, start, count, config.seed, 0);
      var started = root.performance.now();
      var validation;
      var values;
      var failure;
      device.pushErrorScope('validation');
      try {
        device.queue.writeBuffer(paramsBuffer, 0, parameters);
        device.queue.writeBuffer(outputBuffer, 0, clearValues);
        var encoder = device.createCommandEncoder({ label: 'ProbabilityLab GPU range' });
        var pass = encoder.beginComputePass();
        pass.setPipeline(context.pipeline);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP_SIZE));
        pass.end();
        encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, bufferBytes);
        device.queue.submit([encoder.finish()]);
        await readBuffer.mapAsync(mapMode.READ);
        values = new Uint32Array(readBuffer.getMappedRange()).slice();
      } catch (error) {
        failure = error;
      } finally {
        if (readBuffer.mapState === 'mapped') readBuffer.unmap();
        validation = await device.popErrorScope();
      }
      if (context.lost) throw new Error('WebGPU device lost: ' + context.lost);
      if (validation) throw new Error('GPU range validation failed: ' + validation.message);
      if (failure) throw failure;
      return decodeResult(values, n, start, count, config.seed, root.performance.now() - started);
    }

    var ready = Promise.resolve();
    return {
      name: context.name,
      maxBatch: context.maxBatch,
      ready: ready,
      readyPromise: ready,
      run: function (config, start, count) {
        if (closed) return Promise.reject(new Error('GPU adapter is closed'));
        var frozen = { probabilities: config.probabilities.slice(), seed: config.seed >>> 0 };
        var result = context.queue.then(function () { return execute(frozen, start, count); });
        context.queue = result.then(function () {}, function () {});
        pending = result.then(function () {}, function () {});
        return result;
      },
      close: function () {
        if (cleanup) return cleanup;
        closed = true;
        cleanup = pending.then(function () {
          paramsBuffer.destroy();
          outputBuffer.destroy();
          readBuffer.destroy();
        });
        return cleanup;
      }
    };
  }

  var api = { create: create, numerics: { encodeParameters: encodeParameters, decodeResult: decodeResult, layout: layout } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ProbabilityGpu = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
