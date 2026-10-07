(function (root) {
  'use strict';

  var MathEngine = root.DiceMath || (typeof require === 'function' ? require('./engine.js') : null);
  var profiles = new Map();
  var clock = function () { return performance.now(); };

  function cancelled() { return new Error('Simulation cancelled'); }

  function workerAdapter(factory) {
    var worker = factory();
    var pending = null;
    var closed = false;
    var failedError = null;
    var readyResolve;
    var readyReject;
    var ready = new Promise(function (resolve, reject) { readyResolve = resolve; readyReject = reject; });
    ready.catch(function () {});
    var deadline = setTimeout(function () { fail(new Error('Worker did not become ready')); }, 10000);
    function fail(error) {
      failedError = failedError || error;
      clearTimeout(deadline);
      readyReject(error);
      if (pending) { var job = pending; pending = null; job.reject(error); }
    }
    worker.onmessage = function (event) {
      if (closed) return;
      var value = event.data;
      if (value.type === 'ready') { clearTimeout(deadline); readyResolve(); }
      else if (value.type === 'error') fail(new Error(value.message));
      else if (value.type === 'result' && pending) { var job = pending; pending = null; job.resolve(value); }
    };
    worker.onerror = function (event) { fail(new Error(event.message || 'Worker execution failed')); };
    return {
      ready: ready,
      maxBatch: 131072,
      run: function (config, start, count) {
        if (closed) return Promise.reject(cancelled());
        if (failedError) return Promise.reject(failedError);
        if (pending) return Promise.reject(new Error('Worker already has a range in flight'));
        return new Promise(function (resolve, reject) {
          pending = { resolve: resolve, reject: reject };
          try { worker.postMessage({ type: 'range', config: config, start: start, count: count }); }
          catch (error) { fail(error); }
        });
      },
      close: function () {
        if (closed) return;
        closed = true;
        fail(cancelled());
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      }
    };
  }

  function localAdapter() {
    var closed = false;
    var timer = null;
    var rejectPending = null;
    return {
      ready: Promise.resolve(),
      maxBatch: 1000,
      run: function (config, start, count) {
        return new Promise(function (resolve, reject) {
          if (closed) { reject(cancelled()); return; }
          rejectPending = reject;
          var simulation = MathEngine.createSimulation(config.probabilities, config.n, config.seed, start);
          var remaining = count;
          var computeMs = 0;
          function tick() {
            if (closed) { reject(cancelled()); return; }
            var before = clock();
            var amount = Math.min(remaining, 250);
            simulation.advance(amount);
            computeMs += clock() - before;
            remaining -= amount;
            if (remaining > 0) timer = setTimeout(tick, 0);
            else {
              timer = null;
              rejectPending = null;
              var value = simulation.snapshot();
              value.start = start;
              value.end = start + count;
              value.computeMs = computeMs;
              resolve(value);
            }
          }
          timer = setTimeout(tick, 0);
        });
      },
      close: function () {
        closed = true;
        clearTimeout(timer);
        if (rejectPending) { rejectPending(cancelled()); rejectPending = null; }
      }
    };
  }

  function identical(expected, actual) {
    return expected.completed === actual.completed && expected.states.length === actual.states.length && expected.states.every(function (state, i) {
      var other = actual.states[i];
      return other && state.n === other.n && state.sum === other.sum && state.counts.length === other.counts.length && state.dice.length === other.dice.length && state.counts.every(function (v, j) { return v === other.counts[j]; }) && state.dice.every(function (v, j) { return v === other.dice[j]; });
    });
  }

  async function verifyGpu(adapter, config) {
    var fixtures = [
      { probabilities: config.probabilities, seed: config.seed, start: 0 },
      { probabilities: [0, 0.2, 0, 0.3, 0, 0.5], seed: 4294967295, start: 7919 },
      { probabilities: [0, 0, 1, 0, 0, 0], seed: 17, start: 99999500 },
      { probabilities: [1, 1, 1, 1, 1, 1], seed: 1977, start: 10737419 }
    ];
    for (var fixture of fixtures) {
      var trialConfig = { probabilities: fixture.probabilities, n: config.n, seed: fixture.seed };
      var simulation = MathEngine.createSimulation(fixture.probabilities, config.n, fixture.seed, fixture.start);
      simulation.advance(512);
      if (!identical(simulation.snapshot(), await adapter.run(trialConfig, fixture.start, 512))) return false;
    }
    return true;
  }

  function validateConfig(source) {
    if (!Number.isInteger(source.n) || source.n < 1 || source.n > 100) throw new RangeError('Group size must be between 1 and 100');
    if (!Number.isInteger(source.target) || source.target < 1 || source.target > 100000000) throw new RangeError('Group count must be between 1 and 100000000');
    if (!Number.isFinite(source.seed)) throw new RangeError('A finite seed is required');
    if (source.workers !== undefined && (!Number.isInteger(source.workers) || source.workers < 0 || source.workers > 128)) throw new RangeError('Invalid worker count');
    if (source.computeMode !== undefined && !['auto', 'cpu', 'gpu'].includes(source.computeMode)) throw new RangeError('Invalid compute mode');
    return {
      probabilities: MathEngine.normalize(source.probabilities), n: source.n, target: source.target,
      seed: source.seed >>> 0, slow: Boolean(source.slow), paused: Boolean(source.paused),
      workers: source.workers || 0, computeMode: source.computeMode || 'auto', recalibrate: Boolean(source.recalibrate)
    };
  }

  function create(source, onSnapshot, dependencies) {
    var config = validateConfig(source);
    var deps = dependencies || {};
    var navigator = deps.navigator || root.navigator || {};
    var logicalCores = Math.max(1, Math.min(128, Math.floor(navigator.hardwareConcurrency || 2)));
    var memoryGB = Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory : null;
    var automaticLimit = Math.max(1, Math.min(12, logicalCores - (logicalCores > 2 ? 2 : 0), memoryGB !== null && memoryGB <= 4 ? 4 : 12));
    var defaultWorkers = Math.min(2, automaticLimit);
    var factory = deps.workerFactory || function () { return new root.Worker('worker.js'); };
    var gpuFactory = deps.gpuFactory || (root.ProbabilityGpu && root.ProbabilityGpu.create);
    var noWorkers = deps.workerFactory === null || (!deps.workerFactory && (typeof root.Worker !== 'function' || (root.location && root.location.protocol === 'file:')));
    var info = { logicalCores: logicalCores, browserMemoryGB: memoryGB, memoryIsApproximate: true, workers: 0, backend: 'cpu', gpuSupported: false, gpuName: '', profile: [], calibrating: false, fallbackReason: null, groupsPerSecond: null, preparationMs: 0 };
    var states = MathEngine.createSimulation(config.probabilities, config.n, config.seed).snapshot().states;
    var completed = 0;
    var latestGroup = 0;
    var next = 0;
    var retry = [];
    var activeMs = 0;
    var startAt = 0;
    var preparedAt = clock();
    var paused = config.paused;
    var slow = config.slow;
    var stepRequested = false;
    var phase = 'preparing';
    var disposed = false;
    var preparing = true;
    var recovering = false;
    var epoch = 0;
    var timers = new Set();
    var resources = new Set();
    var adapters = [];
    var inFlight = new Map();
    var lastSent = -Infinity;
    var emitTimer = null;
    var slowTimer = null;
    var resolveDone;
    var done = new Promise(function (resolve) { resolveDone = resolve; });

    function later(fn, delay) {
      var id = setTimeout(function () { timers.delete(id); fn(); }, delay);
      timers.add(id);
      return id;
    }
    function clearLater(id) { if (id !== null) { clearTimeout(id); timers.delete(id); } }
    function track(adapter) { resources.add(adapter); return adapter; }
    function close(adapter) { resources.delete(adapter); try { var result = adapter.close(); if (result && result.catch) result.catch(function () {}); } catch (_) {} }
    function closeAll() { Array.from(resources).forEach(close); }
    function snapshot() {
      var elapsedMs = startAt ? clock() - startAt : 0;
      return {
        seed: config.seed, target: config.target, completed: completed, latestGroup: latestGroup, phase: phase,
        backend: info.backend, workers: info.workers, computeMs: activeMs, elapsedMs: elapsedMs,
        info: Object.assign({}, info, { profile: info.profile.map(function (trial) { return Object.assign({}, trial); }) }),
        states: states.map(function (state) { return { n: state.n, counts: state.counts.slice(), dice: state.dice.slice(), sum: state.sum }; })
      };
    }
    function emit(force, error) {
      if (disposed) return;
      if (!force && clock() - lastSent < 80) {
        if (emitTimer === null) emitTimer = later(function () { emitTimer = null; emit(true); }, Math.max(0, 80 - (clock() - lastSent)));
        return;
      }
      clearLater(emitTimer); emitTimer = null;
      var value = snapshot();
      if (error) value.error = String(error.message || error);
      lastSent = clock();
      onSnapshot(value);
      if (phase === 'done' || phase === 'error') resolveDone(value);
    }
    function terminal(error) {
      if (disposed) return;
      phase = 'error'; preparing = false;
      epoch += 1;
      closeAll();
      emit(true, error);
    }
    function merge(value) {
      if (!Number.isInteger(value.completed) || value.completed < 1 || value.seed !== config.seed || value.end - value.start !== value.completed || value.states.length !== states.length || !Number.isFinite(value.computeMs) || value.computeMs < 0) throw new Error('Invalid computation range result');
      for (var index = 0; index < states.length; index += 1) {
        var candidate = value.states[index];
        if (candidate.n !== states[index].n || candidate.counts.length !== states[index].counts.length) throw new Error('Invalid computation distribution result');
        var total = 0;
        for (var bin = 0; bin < candidate.counts.length; bin += 1) {
          var amount = candidate.counts[bin];
          if (!Number.isInteger(amount) || amount < 0 || amount > value.completed) throw new Error('Invalid computation histogram count');
          total += amount;
        }
        if (total !== value.completed || candidate.dice.length !== candidate.n) throw new Error('Incomplete computation distribution result');
        var sum = 0;
        for (var die of candidate.dice) {
          if (!Number.isInteger(die) || die < 1 || die > 6) throw new Error('Invalid computed die value');
          sum += die;
        }
        if (sum !== candidate.sum) throw new Error('Invalid computed group sum');
      }
      for (var i = 0; i < states.length; i += 1) {
        var state = states[i];
        var part = value.states[i];
        for (var j = 0; j < state.counts.length; j += 1) state.counts[j] += part.counts[j];
        if (value.end > latestGroup) { state.dice = Array.from(part.dice); state.sum = part.sum; }
      }
      latestGroup = Math.max(latestGroup, value.end);
      completed += value.completed;
      activeMs += value.computeMs || 0;
    }
    function finish() {
      phase = 'done';
      paused = true;
      clearLater(slowTimer); slowTimer = null;
      closeAll();
      emit(true);
    }
    async function recover(error) {
      if (disposed || recovering) return;
      recovering = true;
      if (info.backend === 'local') { terminal(error); return; }
      epoch += 1;
      inFlight.forEach(function (job) { retry.push({ start: job.start, count: job.count, pausedStep: Boolean(job.pausedStep) }); });
      retry.sort(function (a, b) { return a.start - b.start; });
      inFlight.clear();
      closeAll();
      var gpuFailed = info.backend === 'gpu';
      info.fallbackReason = gpuFailed ? 'gpu_error' : 'worker_error';
      if (gpuFailed && !noWorkers) {
        try {
          adapters = await cpuPool(config.workers ? Math.min(config.workers, logicalCores) : defaultWorkers);
          info.backend = 'cpu'; info.workers = adapters.length;
        } catch (_) {
          if (disposed) return;
          info.backend = 'local'; info.workers = 1;
          adapters = [track(localAdapter())];
        }
      } else {
        info.backend = 'local'; info.workers = 1;
        adapters = [track(localAdapter())];
      }
      if (disposed) return;
      recovering = false;
      emit(true);
      pump();
    }
    function take(amount, pausedReplay) {
      if (retry.length) {
        var index = pausedReplay ? retry.findIndex(function (job) { return job.pausedStep; }) : 0;
        if (index < 0) return null;
        var job = retry[index];
        var count = Math.min(amount, job.count);
        var start = job.start;
        job.start += count; job.count -= count;
        if (job.count === 0) retry.splice(index, 1);
        return { start: start, count: count, pausedStep: Boolean(job.pausedStep) };
      }
      if (pausedReplay) return null;
      var count = Math.min(amount, config.target - next);
      if (count < 1) return null;
      var job = { start: next, count: count };
      next += count;
      return job;
    }
    function pump() {
      if (disposed || preparing || recovering || phase === 'done' || phase === 'error') return;
      if (completed >= config.target) { finish(); return; }
      var replayStep = paused && retry.some(function (job) { return job.pausedStep; });
      if (paused && !stepRequested && !replayStep) {
        if (inFlight.size === 0) { phase = 'paused'; emit(true); }
        return;
      }
      if (slow && inFlight.size > 0) return;
      if (slowTimer !== null) return;
      if ((stepRequested || replayStep) && inFlight.size > 0) return;
      phase = paused ? 'paused' : 'running';
      for (var adapter of adapters) {
        if (inFlight.has(adapter)) continue;
        var isStep = paused && (stepRequested || replayStep);
        var preferredBatch = info.backend === 'gpu' ? Math.max(65536, Math.min(262144, Math.floor(8388608 / (config.n + 28)))) : Math.max(4096, Math.floor(1310720 / (config.n + 28)));
        var amount = slow || isStep ? 1 : Math.min(adapter.maxBatch || 131072, preferredBatch);
        var job = take(amount, replayStep);
        if (!job) break;
        if (isStep) {
          job.pausedStep = true;
          if (!replayStep) stepRequested = false;
        }
        var jobEpoch = epoch;
        inFlight.set(adapter, job);
        adapter.run(config, job.start, job.count).then(function (adapter, jobEpoch, value) {
          if (disposed || jobEpoch !== epoch) return;
          try {
            var assigned = inFlight.get(adapter);
            if (!assigned || value.start !== assigned.start || value.completed !== assigned.count) throw new Error('Computation returned the wrong range');
            merge(value);
            inFlight.delete(adapter);
            if (completed >= config.target) { finish(); return; }
            emit(false);
            if (slow && !paused) slowTimer = later(function () { slowTimer = null; pump(); }, 100);
            pump();
          } catch (error) { recover(error); }
        }.bind(null, adapter, jobEpoch), function (jobEpoch, error) {
          if (!disposed && jobEpoch === epoch) recover(error);
        }.bind(null, jobEpoch));
        if (slow || isStep) break;
      }
    }
    async function cpuPool(count) {
      var pool = [];
      try {
        for (var i = 0; i < count; i += 1) pool.push(track(workerAdapter(factory)));
        await Promise.all(pool.map(function (adapter) { return adapter.ready; }));
        if (disposed) throw cancelled();
        return pool;
      } catch (error) { pool.forEach(close); throw error; }
    }
    async function benchmark(pool, amount) {
      var before = clock();
      var partSize = Math.ceil(amount / pool.length);
      await Promise.all(pool.map(function (adapter, i) {
        var start = i * partSize;
        var count = Math.min(partSize, amount - start);
        return count > 0 ? adapter.run(config, start, count) : Promise.resolve();
      }));
      if (disposed) throw cancelled();
      return clock() - before;
    }
    async function trial(pool, backend) {
      await benchmark(pool, 4096);
      var timings = [];
      for (var i = 0; i < 2; i += 1) timings.push(await benchmark(pool, 131072));
      var elapsedMs = (timings[0] + timings[1]) / 2;
      var record = { backend: backend, workers: pool.length, groups: 131072, elapsedMs: elapsedMs, groupsPerSecond: 131072000 / Math.max(0.01, elapsedMs) };
      info.profile.push(record);
      emit(true);
      return record;
    }
    async function prepare() {
      var pool = null;
      var gpu = null;
      try {
        if (noWorkers) {
          info.backend = 'local'; info.workers = 1;
          info.fallbackReason = root.location && root.location.protocol === 'file:' ? 'file_protocol' : 'worker_error';
          pool = [track(localAdapter())];
        } else {
          var count = config.workers ? Math.min(config.workers, logicalCores) : (slow ? 1 : defaultWorkers);
          var calibrate = (config.target >= 1000000 || config.recalibrate) && config.workers === 0 && !slow && config.computeMode !== 'gpu';
          var profileKey = JSON.stringify([config.n, config.probabilities, logicalCores, memoryGB, Boolean(gpuFactory), config.computeMode]);
          var cached = !config.recalibrate && profiles.get(profileKey);
          if (calibrate && cached) {
            count = cached.workers;
            info.profile = cached.trials.map(function (trial) { return Object.assign({}, trial); });
            info.groupsPerSecond = cached.groupsPerSecond;
          }
          if ((config.computeMode !== 'cpu' && gpuFactory && !slow) || config.computeMode === 'gpu') {
            try {
              if (!gpuFactory) throw new Error('No GPU adapter');
              gpu = track(await gpuFactory(config.n));
              if (disposed) { close(gpu); throw cancelled(); }
              await gpu.ready;
              info.gpuSupported = true; info.gpuName = gpu.name || '';
              if (!(await verifyGpu(gpu, config))) { info.fallbackReason = 'gpu_mismatch'; close(gpu); gpu = null; }
            } catch (error) {
              if (gpu) close(gpu);
              gpu = null;
              info.fallbackReason = 'gpu_unavailable';
              if (disposed) throw error;
            }
          }
          if (gpu && config.computeMode === 'gpu') { pool = [gpu]; gpu = null; info.backend = 'gpu'; }
          else if (calibrate && !cached) {
            info.calibrating = true; emit(true);
            var candidates = [1, 2, 4, 8, 12].filter(function (value) { return value <= automaticLimit; });
            var best = null;
            var bestRecord = null;
            for (var candidate of candidates) {
              var candidatePool = await cpuPool(candidate);
              var record;
              try { record = await trial(candidatePool, 'cpu'); }
              catch (error) { candidatePool.forEach(close); throw error; }
              if (!bestRecord || record.groupsPerSecond > bestRecord.groupsPerSecond * 1.05) {
                if (best) best.forEach(close);
                best = candidatePool; bestRecord = record;
              } else candidatePool.forEach(close);
            }
            if (gpu && config.computeMode === 'auto') {
              try {
                var gpuRecord = await trial([gpu], 'gpu');
                if (gpuRecord.groupsPerSecond > bestRecord.groupsPerSecond * 1.1) {
                  best.forEach(close); best = [gpu]; gpu = null; bestRecord = gpuRecord;
                }
              } catch (error) {
                close(gpu); gpu = null;
                info.fallbackReason = 'gpu_error';
                if (disposed) throw error;
              }
            }
            pool = best;
            info.backend = bestRecord.backend;
            info.groupsPerSecond = bestRecord.groupsPerSecond;
            profiles.set(profileKey, { backend: bestRecord.backend, workers: bestRecord.workers, groupsPerSecond: bestRecord.groupsPerSecond, trials: info.profile.map(function (value) { return Object.assign({}, value); }) });
          } else if (calibrate && cached && cached.backend === 'gpu' && gpu) {
            pool = [gpu]; gpu = null; info.backend = 'gpu';
          } else {
            if (calibrate && cached && cached.backend === 'gpu') {
              var cpuTrials = cached.trials.filter(function (entry) { return entry.backend === 'cpu'; });
              if (cpuTrials.length) {
                var fastestCpu = cpuTrials.reduce(function (best, entry) { return entry.groupsPerSecond > best.groupsPerSecond ? entry : best; });
                count = fastestCpu.workers;
                info.groupsPerSecond = fastestCpu.groupsPerSecond;
              }
            }
            pool = await cpuPool(count);
          }
          if (gpu) close(gpu);
          info.workers = pool.length;
        }
        if (disposed) { if (pool) pool.forEach(close); return; }
        adapters = pool;
        preparing = false; info.calibrating = false;
        info.preparationMs = clock() - preparedAt;
        startAt = clock();
        phase = paused ? 'paused' : 'running';
        emit(true); pump();
      } catch (error) {
        if (disposed) return;
        closeAll();
        info.calibrating = false; info.backend = 'local'; info.workers = 1; info.fallbackReason = 'worker_error';
        adapters = [track(localAdapter())];
        preparing = false; startAt = clock();
        phase = paused ? 'paused' : 'running';
        emit(true); pump();
      }
    }
    emit(true);
    Promise.resolve().then(prepare);
    return {
      done: done,
      send: function (message) {
        if (disposed || phase === 'done' || phase === 'error') return;
        if (message.type === 'pause') {
          paused = true; stepRequested = false;
          clearLater(slowTimer); slowTimer = null;
          if (!preparing && inFlight.size === 0) { phase = 'paused'; emit(true); }
        } else if (message.type === 'resume') {
          paused = false; stepRequested = false;
          if (!preparing) { phase = 'running'; emit(true); pump(); }
        } else if (message.type === 'step' && paused) { stepRequested = true; pump(); }
        else if (message.type === 'speed') {
          slow = Boolean(message.slow);
          if (!slow) { clearLater(slowTimer); slowTimer = null; }
          pump();
        }
      },
      dispose: function () {
        if (disposed) return;
        disposed = true; epoch += 1;
        timers.forEach(function (id) { clearTimeout(id); }); timers.clear();
        closeAll(); inFlight.clear();
        resolveDone(null);
      }
    };
  }

  var api = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ProbabilityCompute = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
