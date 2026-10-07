importScripts('engine.js');

onmessage = function (event) {
  const message = event.data;
  if (message.type !== 'range') return;
  try {
    const before = performance.now();
    const config = message.config;
    const simulation = DiceMath.createSimulation(config.probabilities, config.n, config.seed, message.start);
    simulation.advance(message.count);
    const result = simulation.snapshot();
    result.type = 'result';
    result.start = message.start;
    result.end = message.start + message.count;
    result.computeMs = performance.now() - before;
    postMessage(result, result.states.map(function (state) { return state.counts.buffer; }));
  } catch (error) {
    postMessage({ type: 'error', message: String(error.message || error) });
  }
};

postMessage({ type: 'ready' });
