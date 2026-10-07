@group(0) @binding(0) var<storage, read> params: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<atomic<u32>>;
var<workgroup> histogram: array<atomic<u32>, 773>;

fn random_word(state: u32) -> u32 {
  var value = (state ^ (state >> 15u)) * (state | 1u);
  value ^= value + ((value ^ (value >> 7u)) * (value | 61u));
  return value ^ (value >> 14u);
}

fn face_for(word: u32) -> u32 {
  for (var face = 0u; face < 6u; face++) {
    if ((params[10u] & (1u << face)) != 0u || word < params[4u + face]) {
      return face + 1u;
    }
  }
  return 6u;
}

@compute @workgroup_size(128)
fn simulate(@builtin(global_invocation_id) global_id: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let n = params[2u];
  let histogram_length = 6u * n + 173u;
  for (var bin = lane; bin < histogram_length; bin += 128u) {
    atomicStore(&histogram[bin], 0u);
  }
  workgroupBarrier();

  if (global_id.x < params[1u]) {
    let absolute_group = params[0u] + global_id.x;
    let is_latest = global_id.x == params[1u] - 1u;
    var sizes = array<u32, 5>(n, 1u, 2u, 10u, 15u);
    var offsets = array<u32, 5>(0u, 6u * n + 1u, 6u * n + 8u, 6u * n + 21u, 6u * n + 82u);
    var dice_offsets = array<u32, 5>(0u, n, n + 1u, n + 3u, n + 13u);
    for (var distribution = 0u; distribution < 5u; distribution++) {
      let size = sizes[distribution];
      var state = params[3u] + distribution * 0x9E3779B9u + absolute_group * size * 0x6D2B79F5u;
      var sum = 0u;
      for (var die = 0u; die < size; die++) {
        state += 0x6D2B79F5u;
        let value = face_for(random_word(state));
        sum += value;
        if (is_latest) {
          atomicStore(&output[histogram_length + dice_offsets[distribution] + die], value);
        }
      }
      atomicAdd(&histogram[offsets[distribution] + sum], 1u);
    }
  }
  workgroupBarrier();

  for (var bin = lane; bin < histogram_length; bin += 128u) {
    let count = atomicLoad(&histogram[bin]);
    if (count > 0u) {
      atomicAdd(&output[bin], count);
    }
  }
}
