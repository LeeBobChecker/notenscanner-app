// Klang und MP3 im Browser: MIDI -> Klavier/Streicher (SoundFont) -> gleiche Lautheit -> MP3.
// Läuft im Hintergrund (Worker), funktioniert aber auch direkt, etwa in Tests mit Node.

import { BasicMIDI, BasicSoundBank, SoundBankLoader, SpessaSynthProcessor, SpessaSynthSequencer } from "spessasynth_core";
import { createEncoder, type WasmMediaEncoder } from "wasm-media-encoders/esnext";
import { normalize } from "./loudness.ts";

export const SAMPLE_RATE = 44100;
const BLOCK = 128;
/** Nachklang am Ende, danach wird Stille abgeschnitten */
const TAIL_SECONDS = 3;

export async function loadSoundBank(buffer: ArrayBuffer): Promise<BasicSoundBank> {
  await BasicSoundBank.isSF3DecoderReady;
  return SoundBankLoader.fromArrayBuffer(buffer);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Spielt die MIDI-Datei mit dem SoundFont ab und liefert linken und rechten Kanal. */
export async function synthesize(
  bank: BasicSoundBank,
  midiBytes: Uint8Array,
  onProgress?: (part: number) => void,
): Promise<[Float32Array, Float32Array]> {
  const midi = BasicMIDI.fromArrayBuffer(copyBuffer(midiBytes));
  const synth = new SpessaSynthProcessor(SAMPLE_RATE, { eventsEnabled: false });
  synth.soundBankManager.addSoundBank(bank, "chor");
  await synth.processorInitialized;
  const seq = new SpessaSynthSequencer(synth);
  seq.skipToFirstNoteOn = false; // Pausen am Anfang (späterer Einsatz) bleiben erhalten
  seq.loopCount = 0;
  seq.loadNewSongList([midi]);
  seq.play();
  const count = Math.ceil(SAMPLE_RATE * (midi.duration + TAIL_SECONDS));
  const left = new Float32Array(count);
  const right = new Float32Array(count);
  let filled = 0;
  let blocks = 0;
  while (filled < count) {
    seq.processTick();
    const n = Math.min(BLOCK, count - filled);
    synth.process(left, right, filled, n);
    filled += n;
    if (onProgress && ++blocks % 2000 === 0) onProgress(filled / count);
  }
  // Stille am Ende abschneiden (bis auf eine Viertelsekunde)
  let last = count - 1;
  while (last > 0 && Math.abs(left[last]) < 1e-4 && Math.abs(right[last]) < 1e-4) last--;
  const keep = Math.min(count, last + Math.round(0.25 * SAMPLE_RATE));
  return [left.subarray(0, keep), right.subarray(0, keep)]; // ohne Kopie, spart Speicher auf dem iPhone
}

export type Mp3Encoder = WasmMediaEncoder<"audio/mpeg">;

/** LAME als WebAssembly; wasm = Inhalt von wasm-media-encoders/wasm/mp3.wasm */
export function createMp3Encoder(wasm: ArrayBuffer | Uint8Array): Promise<Mp3Encoder> {
  return createEncoder("audio/mpeg", wasm);
}

/** Stereo-MP3 mit fester Bitrate: ohne VBR-Kopfdaten zeigen Player sonst eine falsche Länge an. */
export function encodeMp3(encoder: Mp3Encoder, left: Float32Array, right: Float32Array): Uint8Array {
  encoder.configure({ sampleRate: SAMPLE_RATE, channels: 2, bitrate: 128 });
  const parts: Uint8Array[] = [];
  const chunk = 1152 * 64;
  for (let i = 0; i < left.length; i += chunk) {
    // encode() liefert einen Blick in den Speicher des Encoders, deshalb kopieren
    parts.push(encoder.encode([left.subarray(i, i + chunk), right.subarray(i, i + chunk)]).slice());
  }
  parts.push(encoder.finalize().slice());
  const size = parts.reduce((s, p) => s + p.length, 0);
  const mp3 = new Uint8Array(size);
  let pos = 0;
  for (const p of parts) {
    mp3.set(p, pos);
    pos += p.length;
  }
  return mp3;
}

/** MIDI -> fertige MP3 (Lautheit -16 LUFS). */
export async function renderMp3(
  bank: BasicSoundBank,
  encoder: Mp3Encoder,
  midiBytes: Uint8Array,
  onProgress?: (part: number) => void,
): Promise<{ mp3: Uint8Array; seconds: number }> {
  const [left, right] = await synthesize(bank, midiBytes, (p) => onProgress?.(p * 0.9));
  normalize([left, right], SAMPLE_RATE);
  const mp3 = encodeMp3(encoder, left, right);
  onProgress?.(1);
  return { mp3, seconds: left.length / SAMPLE_RATE };
}
