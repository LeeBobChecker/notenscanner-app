// Gibt die getrennten Stimmen und Hinweise als JSON aus, im selben Format wie
// dump_voices.py im privaten Repository (Abgleich mit dem Python-Prototyp).
// Aufruf: node tools/dump-voices.ts datei.mxl [korrekturen.json]
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { check } from "../src/checks.ts";
import { applyCorrections, dropChecked, type Step } from "../src/corrections.ts";
import { measureForm } from "../src/form.ts";
import type { Flag, Voices } from "../src/model.ts";
import { loadScore } from "../src/musicxml.ts";
import { splitScore } from "../src/split.ts";

const round = (x: number) => Math.round(x * 1e6) / 1e6;

function voicesJson(voices: Voices) {
  return Object.fromEntries(
    [...voices].map(([name, events]) => [
      name,
      events.map((e) => [e.measure, e.number, round(e.offset), round(e.duration), e.midi, e.tie, e.fermata, e.source]),
    ]),
  );
}

const flagsJson = (flags: Flag[]) => flags.map((f) => [f.measure, f.number, f.voice, f.reason]);

const [path, corrections] = process.argv.slice(2);
const score = loadScore(new Uint8Array(readFileSync(path)), new DOMParser() as never);
const bar = (() => {
  for (const s of score.staffs) for (const m of s.measures) if (m.time) return (m.time[0] * 4) / m.time[1];
  return 4;
})();
const out: Record<string, unknown> = {};
try {
  const { layout, voices, flags } = splitScore(score);
  out.layout = layout;
  out.order = [...voices.keys()];
  out.voices = voicesJson(voices);
  out.flags = flagsJson(flags);
  out.check = flagsJson(check(voices, bar));
  if (corrections) {
    const steps = JSON.parse(readFileSync(corrections, "utf-8")) as Step[];
    const fixed = applyCorrections(voices, steps, measureForm(score));
    out.corrected = voicesJson(fixed.voices);
    out.form = fixed.form;
    out.correctedCheck = flagsJson(dropChecked(check(fixed.voices, bar), steps));
  }
} catch (err) {
  out.error = String((err as Error).message);
}
process.stdout.write(JSON.stringify(out));
