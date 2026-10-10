// Shared registry of live AnalyserNodes so the 3D scene can read audio energy
// without going through React state. The capture hook registers `input` (mic) and
// the playback hook registers `output` (Sparrow's voice). Same idea as the
// portfolio's pointer.ts: a plain mutable object read once per frame.

export const analysers = { input: null, output: null };

export const BAND_COUNT = 16;
const FFT_SIZE = 256; // 128 bins — plenty for 16 visual bands, cheap per frame

export function createAnalyser(ctx) {
  const node = ctx.createAnalyser();
  node.fftSize = FFT_SIZE;
  node.smoothingTimeConstant = 0.6;
  return node;
}

// Log-spaced bin edges: low bands are narrow (where voice energy lives), high
// bands wide. Skips bin 0 (DC).
const EDGES = (() => {
  const bins = FFT_SIZE / 2;
  const edges = [1];
  for (let k = 1; k <= BAND_COUNT; k++) {
    const e = Math.round(Math.pow(bins, k / BAND_COUNT));
    edges.push(Math.max(edges[k - 1] + 1, Math.min(e, bins)));
  }
  return edges;
})();

const scratch = new Uint8Array(FFT_SIZE / 2);

/** Fills `out` (length BAND_COUNT) with 0..1 band energy. Returns false if no analyser. */
export function readBands(analyser, out) {
  if (!analyser) {
    out.fill(0);
    return false;
  }
  analyser.getByteFrequencyData(scratch);
  for (let b = 0; b < BAND_COUNT; b++) {
    const lo = EDGES[b];
    const hi = Math.max(lo + 1, EDGES[b + 1]);
    let sum = 0;
    for (let i = lo; i < hi && i < scratch.length; i++) sum += scratch[i];
    // Gain: speech rarely fills the byte range, so lift it a little.
    out[b] = Math.min(1, (sum / (hi - lo) / 255) * 1.6);
  }
  return true;
}
