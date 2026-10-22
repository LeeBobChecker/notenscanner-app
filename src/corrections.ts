// Korrekturliste für erkannte Partituren: dieselben Schritte, die später die
// Korrekturansicht erzeugt. Takte werden wie im Druck gezählt (ein Auftakt ist
// Takt 0), und zwar so, wie sie nach den vorherigen Schritten nummeriert sind.
//
// Schritte:
//   {"aktion": "taktnummern", "erster": 35}
//   {"aktion": "takt_teilen", "takt": 9, "nach": 4}
//   {"aktion": "takt_ersetzen", "stimme": "Tenor", "takt": 10, "noten": "C#4/4 C#4/4 F#4/4 E4/4"}
//   {"aktion": "takt_einfuegen", "takt": 13, "noten": {"Sopran": "D4/1", "Bass": "D3/1"}}
//   {"aktion": "wiederholung", "von": 1, "bis": 6, "mal": 2}
//   {"aktion": "geprueft", "stimme": "Sopran", "takt": 40}
//
// Notenschreibweise: Tonname mit Oktave (C4 = eingestrichenes c), Vorzeichen # oder b,
// dann / und Notenwert (1, 2, 4, 8, 16, 32), Punkte für punktierte Werte, ~ für einen
// Haltebogen zur nächsten Note. R ist eine Pause. Beispiel: "E4/2. C#4/4~ R/8"
//
// Übertragen aus tools/omr/korrekturen.py (privates Repository).

import { EPS, end, event, type Flag, type NoteEvent, type Tie, type Voices } from "./model.ts";
import type { Mark } from "./form.ts";

export type Step = Record<string, unknown> & { aktion: string };

const NOTE_RE = /^(R|[A-Ga-g][#b]{0,2}-?\d)\/(1|2|4|8|16|32)(\.*)(~?)$/;
const STEP_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pitchMidi(name: string): number {
  // wie music21: b und - erniedrigen, # erhöht; die letzte Ziffer ist die Oktave
  const step = STEP_SEMITONES[name[0].toUpperCase()];
  const octave = Number(name[name.length - 1]);
  let alter = 0;
  for (const c of name.slice(1, -1)) alter += c === "#" ? 1 : -1;
  return (octave + 1) * 12 + step + alter;
}

/** "C#4/4 E4/2. R/4" -> [(midi oder null, Dauer in Vierteln, Bogen)] */
export function parseNotes(text: string): [number | null, number, Tie][] {
  const out: [number | null, number, Tie][] = [];
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const m = NOTE_RE.exec(token);
    if (!m) throw new Error(`Unbekannte Note: '${token}'`);
    const [, name, value, dots, tie] = m;
    let dur = 4 / Number(value);
    dur *= 2 - 0.5 ** dots.length;
    out.push([name === "R" ? null : pitchMidi(name), dur, tie ? "start" : null]);
  }
  return out;
}

/** {Taktnummer|Stimme} der Hinweise, die als geprüft markiert sind. */
function checked(steps: Step[]): Set<string> {
  return new Set(steps.filter((s) => s.aktion === "geprueft").map((s) => `${String(s.takt)}|${String(s.stimme)}`));
}

/** Hinweise ohne die als geprüft markierten. */
export function dropChecked(flags: Flag[], steps: Step[]): Flag[] {
  const done = checked(steps);
  return flags.filter((f) => !done.has(`${f.number}|${f.voice}`));
}

function base(voices: Voices): number {
  const numbers = [...voices.values()].flatMap((events) => events.filter((e) => e.measure === 0).map((e) => e.number));
  return numbers.length && /^\d+$/.test(numbers[0]) ? parseInt(numbers[0], 10) : 1;
}

type Measures = Map<string, NoteEvent[][]>;

function toMeasures(voices: Voices): Measures {
  const count = Math.max(...[...voices.values()].flatMap((events) => events.map((e) => e.measure))) + 1;
  const out: Measures = new Map();
  for (const [name, events] of voices) {
    const measures: NoteEvent[][] = Array.from({ length: count }, () => []);
    for (const e of events) measures[e.measure].push(e);
    out.set(name, measures);
  }
  return out;
}

/** Eine Note nach einem offenen Haltebogen mit gleicher Tonhöhe beendet ihn. */
function closeTies(events: NoteEvent[]): NoteEvent[] {
  for (let k = 0; k + 1 < events.length; k++) {
    const prev = events[k];
    const cur = events[k + 1];
    if ((prev.tie === "start" || prev.tie === "continue") && cur.midi === prev.midi && cur.tie === null) cur.tie = "stop";
  }
  return events;
}

function fromMeasures(measures: Measures, first: number): Voices {
  const voices: Voices = new Map();
  for (const [name, ms] of measures) {
    const events: NoteEvent[] = [];
    ms.forEach((m, idx) => {
      for (const e of m.slice().sort((a, b) => a.offset - b.offset)) {
        events.push({ ...e, measure: idx, number: String(first + idx) });
      }
    });
    voices.set(name, closeTies(events));
  }
  return voices;
}

/** Haltebögen für die beiden Hälften einer geteilten Note. */
function splitTie(tie: Tie): [Tie, Tie] {
  const left: Record<string, Tie> = { start: "start", stop: "continue", continue: "continue" };
  const right: Record<string, Tie> = { start: "continue", stop: "stop", continue: "continue" };
  return [tie === null ? "start" : left[tie], tie === null ? "stop" : right[tie]];
}

function plain(): Mark {
  return { start: false, end: false, times: 2 };
}

function checkIndex(measures: Measures, index: number, label: string): void {
  const count = [...measures.values()][0]?.length ?? 0;
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`${label}: Takt gibt es nicht`);
}

function splitAt(measures: Measures, index: number, at: number, form: Mark[] | null): void {
  checkIndex(measures, index, "Takt teilen");
  if (form) {
    const mark = form[index];
    form.splice(index, 1, { start: mark.start, end: false, times: 2 }, { start: false, end: mark.end, times: mark.times });
  }
  for (const ms of measures.values()) {
    const left: NoteEvent[] = [];
    const right: NoteEvent[] = [];
    for (const e of ms[index]) {
      if (end(e) <= at + EPS) left.push(e);
      else if (e.offset >= at - EPS) right.push({ ...e, offset: e.offset - at });
      else {
        const [lt, rt] = e.midi !== null ? splitTie(e.tie) : [null, null];
        left.push({ ...e, duration: at - e.offset, tie: lt });
        right.push({ ...e, offset: 0, duration: end(e) - at, tie: rt });
      }
    }
    ms.splice(index, 1, left, right);
  }
}

function eventsOf(index: number, text: string): NoteEvent[] {
  const events: NoteEvent[] = [];
  let offset = 0;
  for (const [midi, dur, tie] of parseNotes(text)) {
    events.push(event(index, "", offset, dur, midi, "korrektur", tie));
    offset += dur;
  }
  return events;
}

function replaceMeasure(measures: Measures, voice: string, index: number, text: string): void {
  const ms = measures.get(voice);
  if (!ms) throw new Error(`Stimme '${voice}' gibt es nicht`);
  checkIndex(measures, index, "Takt ersetzen");
  ms[index] = eventsOf(index, text);
}

function insertMeasure(measures: Measures, index: number, notes: Record<string, string>, form: Mark[] | null): void {
  const unknown = Object.keys(notes).filter((v) => !measures.has(v)).sort();
  if (unknown.length) throw new Error(`Stimme(n) ${unknown.join(", ")} gibt es nicht`);
  const fresh = new Map(Object.entries(notes).map(([voice, text]) => [voice, eventsOf(index, text)]));
  const length = Math.max(0, ...[...fresh.values()].flatMap((events) => events.map(end)));
  for (const [voice, ms] of measures) {
    const filler = length ? [event(index, "", 0, length, null, "korrektur")] : [];
    ms.splice(index, 0, fresh.get(voice) ?? filler);
  }
  if (form) form.splice(index, 0, plain());
}

/** Wendet die Schritte der Reihe nach an. Mit Form wandern Wiederholungszeichen bei
 *  geteilten und eingefügten Takten mit. */
export function applyCorrections(voices: Voices, steps: Step[], form: Mark[] | null = null): { voices: Voices; form: Mark[] | null } {
  let first = base(voices);
  const measures = toMeasures(voices);
  const marks = form ? form.map((m) => ({ ...m })) : null;
  const count = [...measures.values()][0]?.length ?? 0;
  if (marks && marks.length < count) for (let k = marks.length; k < count; k++) marks.push(plain());
  const int = (v: unknown) => parseInt(String(v), 10);
  for (const step of steps) {
    switch (step.aktion) {
      case "taktnummern":
        first = int(step.erster);
        break;
      case "takt_teilen":
        splitAt(measures, int(step.takt) - first, Number(step.nach), marks);
        break;
      case "takt_ersetzen":
        replaceMeasure(measures, String(step.stimme), int(step.takt) - first, String(step.noten));
        break;
      case "takt_einfuegen":
        insertMeasure(measures, int(step.takt) - first, step.noten as Record<string, string>, marks);
        break;
      case "geprueft":
        break; // betrifft nur die Anzeige der Hinweise, siehe dropChecked
      case "wiederholung":
        if (marks) {
          const from = int(step.von) - first;
          const to = int(step.bis) - first;
          marks[from].start = true;
          marks[to].end = true;
          marks[to].times = step.mal === undefined ? 2 : int(step.mal);
        }
        break;
      default:
        throw new Error(`Unbekannte Aktion: '${step.aktion}'`);
    }
  }
  return { voices: fromMeasures(measures, first), form: marks };
}
