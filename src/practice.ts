// Ablauf ohne Oberfläche: Datei einlesen, Stimmen trennen, prüfen und die
// Übedateien planen (Dateinamen und MIDI je Stimme, Variante und Übetempo).

import { check } from "./checks.ts";
import { expand, hasVoltas, measureForm, playOrder, type Mark } from "./form.ts";
import { buildMidi, timeline, type Mode, type TimeSignature } from "./midi.ts";
import type { Flag, Voices } from "./model.ts";
import { loadScore, type Score, type XmlParser } from "./musicxml.ts";
import { LayoutError, splitScore } from "./split.ts";

export interface Analysis {
  title: string;
  layout: string;
  /** Klavier oder andere Systeme, die übergangen werden */
  skippedStaffs: number;
  voices: Voices;
  flags: Flag[];
  form: Mark[];
  voltas: boolean;
  repeats: boolean;
  ts: TimeSignature;
  measures: number;
  tempo: number | null;
}

export const LAYOUT_LABELS: Record<string, string> = {
  SATB: "Geschlossener Satz: Sopran und Alt im oberen, Tenor und Bass im unteren System",
  "SATB-offen": "Offene Partitur: ein System je Stimme",
  benannt: "Stimmen mit Namen aus der Datei",
};

export class UnsupportedScore extends Error {}

function firstTimeSignature(score: Score): TimeSignature {
  for (const s of score.staffs) for (const m of s.measures) if (m.time) return { numerator: m.time[0], denominator: m.time[1] };
  return { numerator: 4, denominator: 4 };
}

/** Name ohne Endung und ohne Zeichen, die in Dateinamen stören. */
export function cleanTitle(text: string): string {
  return text.replace(/\.(mxl|musicxml|xml)$/i, "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Der Dateiname ist verlässlicher als der Titel aus der Texterkennung; stimmen beide
 *  überein, hat der erkannte Titel die schönere Schreibweise. */
export function chooseTitle(recognized: string, fileName: string): string {
  const fromFile = titleFromFileName(fileName);
  const fromScore = cleanTitle(recognized);
  const plain = (t: string) => t.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
  if (fromScore && plain(fromScore) === plain(fromFile)) return fromScore;
  return fromFile || fromScore || "Stück";
}

/** Titel aus dem Dateinamen ("035_Der_Herr_mein_Hirte.mxl" -> "035 Der Herr mein Hirte"). */
export function titleFromFileName(fileName: string): string {
  let name = cleanTitle(fileName).replace(/_/g, " ");
  if (!name.includes(" ")) name = name.replace(/-/g, " ");
  name = name.replace(/\s+/g, " ").trim();
  return name === name.toLowerCase() ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

export function analyze(bytes: Uint8Array, parser: XmlParser, fileName = ""): Analysis {
  const score = loadScore(bytes, parser);
  let result;
  try {
    result = splitScore(score);
  } catch (err) {
    if (err instanceof LayoutError) {
      const count = Number(/^(\d+)/.exec(err.message)?.[1] ?? 0);
      throw new UnsupportedScore(
        `In dieser Datei stehen ${count} Notensysteme untereinander. Die App kennt bisher den geschlossenen Satz ` +
          "(zwei Systeme) und die offene Partitur (vier Systeme), jeweils auch mit Klavier darunter. " +
          "Für Doppelchor oder wechselnde Besetzung schick die Noten bitte an Claude.",
      );
    }
    throw err;
  }
  const ts = firstTimeSignature(score);
  const bar = (ts.numerator * 4) / ts.denominator;
  const form = measureForm(score);
  const singles = score.staffs.filter((s) => !s.partStaff).length;
  return {
    title: chooseTitle(score.title, fileName),
    layout: result.layout,
    skippedStaffs: singles ? score.staffs.length - singles : 0,
    voices: result.voices,
    flags: [...result.flags, ...check(result.voices, bar)],
    form,
    voltas: hasVoltas(score),
    repeats: form.some((m) => m.end),
    ts,
    measures: form.length,
    tempo: score.tempo,
  };
}

export interface PackageOptions {
  title: string;
  /** Stimmen für Solo und Übe-Mix */
  targets: string[];
  variants: Mode[];
  /** Übetempi in Prozent, z. B. [100, 85] */
  percents: number[];
  /** Grundtempo in Vierteln pro Minute */
  tempo: number;
  /** wie oft das ganze Stück hintereinander (Strophen) */
  passes: number;
  /** MIDI-Dateien dazulegen */
  midi: boolean;
}

export interface PlannedFile {
  name: string;
  kind: "mp3" | "mid";
  /** Stimme und Variante, z. B. "Tenor – Übe-Mix" */
  label: string;
  percent: number | null;
  midi: Uint8Array;
}

export const MODE_LABELS: Record<Mode, string> = { solo: "Solo", mix: "Übe-Mix", gesamt: "Gesamt" };

/** Alle Dateien des Pakets; die MP3s entstehen danach aus ihrer MIDI-Fassung. */
export function planFiles(analysis: Analysis, options: PackageOptions): PlannedFile[] {
  const voices = expand(analysis.voices, playOrder(analysis.form), Math.max(1, Math.round(options.passes)));
  const { starts } = timeline(voices);
  const title = cleanTitle(options.title) || "Stück";
  const jobs: [string | null, Mode][] = [];
  for (const voice of options.targets) {
    for (const mode of options.variants) if (mode !== "gesamt") jobs.push([voice, mode]);
  }
  if (options.variants.includes("gesamt")) jobs.push([null, "gesamt"]);
  const files: PlannedFile[] = [];
  for (const [voice, mode] of jobs) {
    const label = voice === null ? MODE_LABELS[mode] : `${voice} – ${MODE_LABELS[mode]}`;
    const base = `${title} – ${label}`;
    if (options.midi) {
      files.push({ name: `${base}.mid`, kind: "mid", label, percent: null, midi: buildMidi(voices, starts, voice, mode, options.tempo, analysis.ts) });
    }
    for (const p of options.percents) {
      files.push({
        name: `${base} – ${p} %.mp3`,
        kind: "mp3",
        label,
        percent: p,
        midi: buildMidi(voices, starts, voice, mode, (options.tempo * p) / 100, analysis.ts),
      });
    }
  }
  return files;
}

/** Vorschlag für die eigene Stimme: im Doppelchor Tenor II, sonst Tenor. */
export function defaultVoice(names: string[], remembered: string | null): string {
  if (remembered && names.includes(remembered)) return remembered;
  for (const name of ["Tenor II", "Tenor", "Tenor 2", "Tenor I", "Tenor 1"]) if (names.includes(name)) return name;
  return names[0] ?? "";
}
