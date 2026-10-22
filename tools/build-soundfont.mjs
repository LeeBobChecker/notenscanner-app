// Baut den Klang der App: aus FluidR3_GM (MIT-Lizenz) nur Klavier (Programm 0)
// und Streicher (Programm 48), Samples als Ogg Vorbis komprimiert (SF3).
//
// Aufruf: node tools/build-soundfont.mjs [/usr/share/sounds/sf2/FluidR3_GM.sf2]
// Braucht ffmpeg mit libvorbis. Ergebnis: src/assets/chor.sf3
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BasicSoundBank, SoundBankLoader } from "spessasynth_core";

const source = process.argv[2] ?? "/usr/share/sounds/sf2/FluidR3_GM.sf2";
const target = new URL("../src/assets/chor.sf3", import.meta.url);
const PROGRAMS = [0, 48];

function wav16(samples, rate) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + samples.length * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), 44 + i * 2);
  }
  return data;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klang-"));
let counter = 0;
async function vorbis(samples, rate) {
  const base = path.join(tmp, `s${counter++}`);
  fs.writeFileSync(`${base}.wav`, wav16(samples, rate));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", `${base}.wav`, "-c:a", "libvorbis", "-q:a", "6", `${base}.ogg`]);
  return new Uint8Array(fs.readFileSync(`${base}.ogg`));
}

const raw = fs.readFileSync(source);
const full = SoundBankLoader.fromArrayBuffer(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const wanted = full.presets.filter((p) => PROGRAMS.includes(p.program) && p.bankMSB === 0 && p.bankLSB === 0 && !p.isGMGSDrum);
if (wanted.length !== PROGRAMS.length) throw new Error(`Presets nicht gefunden: ${wanted.map((p) => p.name)}`);
const bank = new BasicSoundBank();
bank.soundBankInfo = { ...full.soundBankInfo, name: "Chor-Übedateien (aus FluidR3_GM)" };
bank.addCompletePresets(wanted);
await bank.setSampleFormat({ format: "compressed", compressionFunction: vorbis });
const out = bank.writeSF2({ software: "noten-scanner-app" });
fs.writeFileSync(target, new Uint8Array(out));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${wanted.map((p) => p.name).join(", ")}: ${(out.byteLength / 1e6).toFixed(1)} MB -> ${target.pathname}`);
