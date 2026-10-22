// Erzeugt die MIDI-Übedateien eines Stücks wie render_practice.py (ohne MP3),
// für den Abgleich mit dem Python-Prototyp.
// Aufruf: node tools/practice-midi.ts datei.mxl ausgabeordner --title "Titel" --tempo 76
//         [--korrekturen liste.json] [--voice Tenor|alle] [--varianten solo mix gesamt] [--durchlaeufe 1]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { applyCorrections, type Step } from "../src/corrections.ts";
import { expand, measureForm, playOrder } from "../src/form.ts";
import { buildMidi, timeline, type Mode } from "../src/midi.ts";
import { loadScore } from "../src/musicxml.ts";
import { splitScore } from "../src/split.ts";

const argv = process.argv.slice(2);
const [path, outDir] = argv;
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const list = (name: string, fallback: string[]) => {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const out: string[] = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith("--"); k++) out.push(argv[k]);
  return out;
};
const title = opt("--title", "Stück");
const tempo = Number(opt("--tempo", "66"));
const voiceArg = opt("--voice", "Tenor");
const variants = list("--varianten", ["solo", "mix"]) as Mode[];
const passes = Number(opt("--durchlaeufe", "1"));
const correctionsPath = opt("--korrekturen", "");

const score = loadScore(new Uint8Array(readFileSync(path)), new DOMParser() as never);
let { voices } = splitScore(score);
let form = measureForm(score);
if (correctionsPath) {
  const steps = JSON.parse(readFileSync(correctionsPath, "utf-8")) as Step[];
  if (steps.length) ({ voices, form } = applyCorrections(voices, steps, form) as { voices: typeof voices; form: typeof form });
}
let ts = { numerator: 4, denominator: 4 };
outer: for (const s of score.staffs) for (const m of s.measures) if (m.time) { ts = { numerator: m.time[0], denominator: m.time[1] }; break outer; }
const expanded = expand(voices, playOrder(form), passes);
const { starts } = timeline(expanded);
mkdirSync(outDir, { recursive: true });
const labels: Record<Mode, string> = { solo: "Solo", mix: "Übe-Mix", gesamt: "Gesamt" };
const targets = voiceArg === "alle" ? [...expanded.keys()] : [voiceArg];
const jobs: [string | null, Mode][] = targets.flatMap((v) => variants.filter((m) => m !== "gesamt").map((m) => [v, m] as [string, Mode]));
if (variants.includes("gesamt")) jobs.push([null, "gesamt"]);
for (const [voice, mode] of jobs) {
  const base = voice === null ? `${title} – ${labels[mode]}` : `${title} – ${voice} – ${labels[mode]}`;
  writeFileSync(join(outDir, `${base}.mid`), buildMidi(expanded, starts, voice, mode, tempo, ts));
  console.log(`${base}.mid`);
}
