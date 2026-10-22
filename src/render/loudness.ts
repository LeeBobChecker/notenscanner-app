// Lautheit nach EBU R 128 / ITU-R BS.1770-4 (integrierte Lautheit in LUFS),
// damit alle Übedateien gleich laut sind (Ziel -16 LUFS wie im Prototyp).

interface Biquad {
  b: [number, number, number];
  a: [number, number];
}

/** K-Filter für eine beliebige Abtastrate (Koeffizienten wie libebur128). */
function kWeighting(rate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const gain = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / rate);
  const vh = 10 ** (gain / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b: [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0],
    a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
  };
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + k / q + k * k;
  const highpass: Biquad = { b: [1, -2, 1], a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0] };
  return [shelf, highpass];
}

function filter(x: Float32Array, stages: Biquad[]): Float64Array {
  let input: ArrayLike<number> = x;
  let out = new Float64Array(0);
  for (const { b, a } of stages) {
    out = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const x0 = input[i];
      const y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      out[i] = y0;
    }
    input = out;
  }
  return out;
}

/** Integrierte Lautheit in LUFS; -Infinity bei Stille. */
export function integratedLoudness(channels: Float32Array[], rate: number): number {
  const stages = kWeighting(rate);
  const filtered = channels.map((c) => filter(c, stages));
  const block = Math.round(0.4 * rate);
  const step = Math.round(0.1 * rate);
  const length = channels[0].length;
  const powers: number[] = [];
  for (let start = 0; start + block <= length; start += step) {
    let sum = 0;
    for (const f of filtered) {
      let s = 0;
      for (let i = start; i < start + block; i++) s += f[i] * f[i];
      sum += s / block;
    }
    powers.push(sum);
  }
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p);
  const absolute = powers.filter((p) => lufs(p) > -70);
  if (absolute.length === 0) return -Infinity;
  const mean = (list: number[]) => list.reduce((s, p) => s + p, 0) / list.length;
  const threshold = lufs(mean(absolute)) - 10;
  const gated = absolute.filter((p) => lufs(p) > threshold);
  return lufs(mean(gated.length ? gated : absolute));
}

/** Verstärkung auf die Ziellautheit; der lauteste Abtastwert bleibt unter peakDb. */
export function normalize(channels: Float32Array[], rate: number, target = -16, peakDb = -2): number {
  const loudness = integratedLoudness(channels, rate);
  if (!Number.isFinite(loudness)) return 1;
  let gain = 10 ** ((target - loudness) / 20);
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  const ceiling = 10 ** (peakDb / 20);
  if (peak * gain > ceiling) gain = ceiling / peak;
  for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= gain;
  return gain;
}
