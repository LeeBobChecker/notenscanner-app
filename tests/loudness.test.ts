import { describe, expect, it } from "vitest";
import { integratedLoudness, normalize } from "../src/render/loudness.ts";

const RATE = 44100;

function sine(amplitude: number, seconds = 5, freq = 997): Float32Array {
  const out = new Float32Array(RATE * seconds);
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / RATE);
  return out;
}

describe("Lautheit", () => {
  it("misst einen Sinuston wie EBU Tech 3341 (Testfall 1)", () => {
    // 1 kHz auf beiden Kanälen mit -23 dBFS Spitzenpegel ergibt -23 LUFS
    const a = 10 ** (-23 / 20);
    expect(integratedLoudness([sine(a, 5, 1000), sine(a, 5, 1000)], RATE)).toBeCloseTo(-23, 1);
    expect(integratedLoudness([sine(a, 5, 1000)], RATE)).toBeCloseTo(-26.01, 1);
  });

  it("bringt alles auf -16 LUFS", () => {
    const channels = [sine(0.05), sine(0.05)];
    normalize(channels, RATE);
    expect(integratedLoudness(channels, RATE)).toBeCloseTo(-16, 1);
  });

  it("lässt Stille in Ruhe", () => {
    const channels = [new Float32Array(RATE), new Float32Array(RATE)];
    expect(normalize(channels, RATE)).toBe(1);
  });
});
