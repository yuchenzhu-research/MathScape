# Numerical contract

ProbabilityLab runs an actual Monte Carlo experiment. It does not draw a normal
curve and fabricate samples to match it. The normal approximation and exact
convolution are separate reference distributions; neither changes the sampled
histogram.

## Reproducible streams

The five experiments have group sizes `[n, 1, 2, 10, 15]`. Distribution index `i`
starts from this unsigned 32-bit seed:

```text
seed_i = (seed + i × 0x9E3779B9) mod 2^32
```

The existing Mulberry32 generator increments its state by `0x6D2B79F5` before
each roll. A range starting at absolute group index `g` and using group size `s`
therefore starts at:

```text
range_seed = (seed_i + g × s × 0x6D2B79F5) mod 2^32
```

CPU workers receive disjoint half-open ranges `[start, end)`. A GPU invocation
receives one absolute group index. Both derive the same roll sequence from this
formula. Integer additions and multiplications wrap modulo `2^32`; CPU code
uses `Math.imul`, while the GPU uses WGSL `u32` arithmetic.

As a result, changing worker count, batch size, completion order, or CPU/GPU
backend does not change the completed histogram for the same probabilities,
group size, group count and seed. The most recent dice come from the highest
completed range end, not from the response that arrived last. During a parallel
run, that group's index can be larger than the number of completed groups.

An interrupted, unmerged range can be retried on another backend. Its stream is
identified by the range, not by a worker's mutable random state. Results from a
cancelled computation generation are ignored.

## Exact CPU/GPU face selection

The CPU normalizes the six weights and builds a cumulative distribution using
JavaScript binary64 arithmetic. It selects the first face satisfying:

```text
random_word / 2^32 < cumulative_probability
```

The GPU does not round this cumulative probability to binary32. JavaScript
encodes each threshold as:

```text
threshold = ceil(cumulative_probability × 2^32)
```

The integer kernel tests `random_word < threshold`, which is the same strict
comparison for every unsigned 32-bit random word. A threshold at `2^32` is
represented by a separate mask bit, because `2^32` itself cannot fit in `u32`.
This also handles cumulative values slightly below one whose ceiling is
`2^32`. Zero-probability faces remain impossible, and a deterministic die
remains a point mass.

This contract is bit-exact for sampled counts, latest dice and latest sums. It
does not require the exact-convolution or normal-approximation calculations to
run on the GPU. See the [WGSL specification](https://www.w3.org/TR/WGSL/) for
unsigned arithmetic, workgroup barriers and atomic operations.

## Supported bounds

- The interface supports `1 ≤ n ≤ 100`, `1 ≤ M ≤ 100,000,000` and unsigned
  32-bit seeds. CPU range starts are limited to `100,000,000` by the math engine.
- The lower-level GPU adapter accepts unsigned 32-bit group indices, with
  `start + count ≤ 2^32`. A dispatch must also fit its reported `maxBatch`, which
  is capped at `1,048,576` groups and the device's dispatch limit. The public
  interface uses the smaller bounds above.
- GPU batch histogram bins are `u32`. The batch limit prevents overflow; merged
  histograms are JavaScript `Float64Array` values. Integers through the maximum
  public group count are represented exactly.
- Mulberry32 is a finite-state, deterministic pseudorandom generator, not a
  cryptographic source or a proof of statistical independence. Its odd state
  increment cycles through `2^32` states; the random-word sequence repeats after
  at most `2^32` rolls. At `n = 100` and `M = 100,000,000`, the main experiment
  consumes 10,000,000,000 words, exceeding that state period. Counts remain
  correct for this implemented stream, but repeated states mean that mathematical
  independence cannot be assumed at this scale.
- The five distinct stream seeds are a pedagogical sampling convention, not a
  proof that the five experiments are statistically independent. A fixed seed
  is for reproducibility. Research-quality Monte Carlo at very large scales
  should use a stronger, appropriately validated counter-based generator in the
  future; the current implementation preserves the existing stream so CPU/GPU
  comparisons remain reproducible.
- Increasing `M` stabilizes an empirical distribution; increasing `n` is what
  makes a nondegenerate sum or average approach a normal shape under the central
  limit theorem's independence assumptions.

## Memory is bounded by the histogram, not the sample count

The GPU retains five histograms and only the latest group of dice. It never
allocates an array containing all `M` simulated groups.

For group size `n`, the packed result has `7n + 201` unsigned 32-bit words. One
adapter preallocates a 44-byte parameter buffer, one result buffer and one
readback buffer:

```text
adapter buffer bytes = 44 + 2 × (7n + 201) × 4
```

At `n = 100`, these three GPU buffers total **7,252 bytes**, about 7.1 KiB. Each
active workgroup also uses a 773-word shared histogram (**3,092 bytes**).
These numbers exclude browser and worker heaps, host-side snapshots, the GPU
device, compiler/pipeline state, driver allocations, and other application
resources. They are not a claim that the entire program uses only 7 KiB.

Buffers are reused between batches. Closing an adapter waits for its queued or
in-flight readback to settle, unmaps the readback buffer, and then destroys its
buffers. The device and pipeline are cached for reuse; device loss invalidates
that cache.

## Validation and fallback

GPU initialization requests an actual browser WebGPU adapter and rejects a
software fallback adapter. The browser can return no adapter even when the API
exists; hardware names can also be unavailable. See
[requestAdapter](https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter)
and [adapter.info](https://developer.mozilla.org/en-US/docs/Web/API/GPUAdapter/info).

Before selecting GPU execution, the scheduler compares multiple small GPU
experiments against the CPU implementation, including zero-probability faces,
large group offsets and an extreme seed. A mismatch, unavailable adapter,
compilation/validation error, or lost device prevents continued GPU execution
and triggers a visible CPU/local fallback. A CPU calculation is never labelled
as GPU execution.

The numerical unit tests cover RNG words, strict CDF boundaries, buffer layout,
large-offset ranges, deterministic dice, partition invariance, and adapter
failure/cleanup behavior. In the local browser verification, 36 actual GPU
fixtures across `n = 1, 10, 100` matched CPU counts and latest dice exactly; an
additional 1,000,000-group run matched all five CPU histograms. These are
recorded local checks, not a claim that every browser/GPU combination has been
tested.

GPU adapter `computeMs` includes command submission, GPU execution and readback.
CPU `computeMs` accumulates worker compute durations and can exceed elapsed
wall time when workers overlap. Automatic routing compares elapsed wall time;
the two compute-duration fields are not interchangeable kernel timings.
