// Stimmentrennung: aus den Notensystemen der Erkennung werden einzelne Stimmen.
//
// Im geschlossenen Satz teilen sich je zwei Stimmen ein System. Die Zuordnung
// geschieht Takt für Takt:
// 1. Akkord an einem Hals: höchster Ton zur oberen, tiefster zur unteren Stimme.
// 2. Einzelnote: Hals nach oben -> obere Stimme, Hals nach unten -> untere.
// 3. Ohne Hals (ganze Note) oder bei Pausen entscheidet die Stimmnummer
//    (1 = oben, 2 = unten), notfalls die Tonhöhe.
// 4. Bleibt in einer Stimme eine Lücke, während die andere Stimme dort eine
//    Note hat, ist das ein Unisono (ein Notenkopf für beide): die Note wird
//    kopiert. Sonst wird die Lücke zur Pause.
//
// In der offenen Partitur (ein System je Stimme) zählt die Halsrichtung nicht;
// dort werden nur Takte mit zwei Stimmen oder Akkorden geteilt (Divisi). Die
// untere Hälfte („Bass 2“) singt in den ungeteilten Takten die gemeinsame Stimme
// mit. Steht der Tenor im Violinschlüssel ohne kleine 8, wird er eine Oktave
// tiefer gesetzt. Im Klavierauszug zählen nur die Chorsysteme.
//
// Übertragen aus dem Python-Prototyp (tools/omr/satb_split.py im privaten Repository).

import { EPS, end, event, type Flag, type NoteEvent, type Voices } from "./model.ts";
import type { Item, Measure, Score, Staff } from "./musicxml.ts";

/** Geschlossener Satz: welche Stimmen in welchem System stehen (von oben nach unten). */
export const LAYOUTS: Record<string, [string, string | null][]> = {
  SATB: [["Sopran", "Alt"], ["Tenor", "Bass"]],
  SSATTBB: [["Sopran 1", "Sopran 2"], ["Alt", null], ["Tenor 1", "Tenor 2"], ["Bass 1", "Bass 2"]],
};
/** Offene Partitur: ein System je Stimme. */
export const OPEN_LAYOUTS: Record<string, string[]> = { "SATB-offen": ["Sopran", "Alt", "Tenor", "Bass"] };

const VOICE_NAME = /^(Sopran|Alt|Tenor|Bass)( (I|II|III|1|2|3|in ripieno))?$/;

function toEvent(it: Item, idx: number, number: string, midi: number | null, source: string): NoteEvent {
  return event(idx, number, it.offset, it.ql, midi, source, it.tie, it.fermata);
}

function overlaps(a: NoteEvent, b: NoteEvent): boolean {
  return a.offset < end(b) - EPS && b.offset < end(a) - EPS;
}

/** Sortiert und entfernt doppelte Einträge an derselben Stelle. */
function clean(events: NoteEvent[], flags: Flag[], idx: number, number: string, label: string): NoteEvent[] {
  events.sort((a, b) => a.offset - b.offset || Number(a.midi === null) - Number(b.midi === null));
  const out: NoteEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && overlaps(last, e)) {
      if (e.midi !== null && last.midi !== null) {
        flags.push({ measure: idx, number, voice: label, reason: "zwei Noten gleichzeitig in einer Stimme" });
      }
      continue;
    }
    out.push(e);
  }
  return out;
}

/** Füllt Lücken: Unisono-Kopie aus der Partnerstimme, sonst Pause. */
function fillGaps(events: NoteEvent[], other: NoteEvent[], length: number, idx: number, number: string): NoteEvent[] {
  const out: NoteEvent[] = [];
  let t = 0;
  for (const e of [...events, null]) {
    const gapEnd = e === null ? length : e.offset;
    if (gapEnd - t > EPS) {
      for (const o of other) {
        if (o.midi !== null && o.offset >= t - EPS && end(o) <= gapEnd + EPS) {
          if (o.offset - t > EPS) out.push(event(idx, number, t, o.offset - t, null, "gap"));
          out.push({ ...o, source: "unison" });
          t = end(o);
        }
      }
      if (gapEnd - t > EPS) out.push(event(idx, number, t, gapEnd - t, null, "gap"));
    }
    if (e === null) break;
    out.push(e);
    t = Math.max(t, end(e));
  }
  return out;
}

/** Teilt einen Takt eines Systems in (obere, untere) Ereignislisten.
 *  unisonLower=false: Lücken der unteren Stimme werden zu Pausen statt zu Unisono-Kopien (Divisi). */
export function splitMeasure(measure: Measure, idx: number, unisonLower = true): [NoteEvent[], NoteEvent[], Flag[]] {
  const number = measure.number;
  let upper: NoteEvent[] = [];
  let lower: NoteEvent[] = [];
  const undecided: [Item, number][] = [];
  const flags: Flag[] = [];
  const rests: Item[] = [];
  for (const it of measure.items) {
    if (it.grace) continue;
    if (it.kind === "rest") {
      rests.push(it);
      continue;
    }
    const pitches = it.pitches;
    if (pitches.length >= 2) {
      upper.push(toEvent(it, idx, number, pitches[pitches.length - 1], "chord"));
      lower.push(toEvent(it, idx, number, pitches[0], "chord"));
      if (pitches.length > 2) {
        flags.push({ measure: idx, number, voice: "beide", reason: `Akkord mit ${pitches.length} Tönen (Stimmteilung?)` });
      }
      continue;
    }
    if (it.stem === "up") upper.push(toEvent(it, idx, number, pitches[0], "stem"));
    else if (it.stem === "down") lower.push(toEvent(it, idx, number, pitches[0], "stem"));
    else if (it.voice === "1") upper.push(toEvent(it, idx, number, pitches[0], "voice"));
    else if (it.voice === "2") lower.push(toEvent(it, idx, number, pitches[0], "voice"));
    else undecided.push([it, pitches[0]]);
  }

  // Ohne Hals und ohne Stimmnummer: Tonhöhe mit den Nachbarn vergleichen.
  for (const [it, midi] of undecided) {
    const others = [...upper, ...lower].filter((e) => Math.abs(e.offset - it.offset) < EPS).map((e) => e.midi as number);
    const target = others.length === 0 || midi >= Math.max(...others) ? upper : lower;
    target.push(toEvent(it, idx, number, midi, "pitch"));
  }

  // Pausen nur dort übernehmen, wo die Stimme sonst nichts hat.
  for (const it of rests) {
    const target = it.voice === "1" || it.voice === null ? upper : lower;
    const rest = toEvent(it, idx, number, null, "voice");
    if (!target.some((e) => overlaps(rest, e))) target.push(rest);
  }

  const length = measure.length;
  upper = clean(upper, flags, idx, number, "oben");
  lower = clean(lower, flags, idx, number, "unten");
  const upperFilled = fillGaps(upper, lower, length, idx, number);
  const lowerFilled = fillGaps(lower, unisonLower ? upper : [], length, idx, number);
  return [upperFilled, lowerFilled, flags];
}

/** Takt eines Systems mit nur einer Stimme: die Halsrichtung spielt keine Rolle. */
export function singleMeasure(measure: Measure, idx: number, name: string): [NoteEvent[], Flag[]] {
  const number = measure.number;
  const notes: NoteEvent[] = [];
  const rests: NoteEvent[] = [];
  const flags: Flag[] = [];
  for (const it of measure.items) {
    if (it.grace) continue;
    if (it.kind === "rest") {
      rests.push(toEvent(it, idx, number, null, "voice"));
      continue;
    }
    notes.push(toEvent(it, idx, number, Math.max(...it.pitches), "single"));
  }
  notes.sort((a, b) => (b.midi as number) - (a.midi as number)); // bei Überschneidung gewinnt der höhere Ton
  const free = rests.filter((r) => !notes.some((e) => overlaps(r, e)));
  const events = clean([...notes, ...free], flags, idx, number, name);
  return [fillGaps(events, [], measure.length, idx, number), flags];
}

/** Die Chorsysteme von oben nach unten: gibt es neben Teilen mit mehreren Systemen
 *  (Klavier) einzelne Systeme, sind nur diese der Chor. */
export function staves(score: Score): Staff[] {
  const singles = score.staffs.filter((s) => !s.partStaff);
  return singles.length ? singles : score.staffs;
}

/** Stimmnamen aus den Teilnamen, wenn jedes Chorsystem genau eine Stimme trägt und so heißt. */
export function namedVoices(score: Score): string[] | null {
  const names = staves(score).map((s) => s.name.trim());
  if (names.length > 0 && new Set(names).size === names.length && names.every((n) => VOICE_NAME.test(n))) return names;
  return null;
}

export class LayoutError extends Error {}

/** Benannte Stimmen; sonst zwei Systeme: geschlossener Satz; vier Systeme: offene Partitur. */
export function detectLayout(score: Score): string {
  if (namedVoices(score)) return "benannt";
  const count = staves(score).length;
  if (count === 2) return "SATB";
  if (count === 4) return "SATB-offen";
  throw new LayoutError(`${count} Systeme gefunden; bekannt sind 2 (geschlossener Satz) und 4 (offene Partitur)`);
}

function plainTreble(staff: Staff): boolean {
  return staff.clef !== null && staff.clef[0] === "G" && !staff.clef[1];
}

function multiVoice(measure: Measure): boolean {
  return measure.voices.length >= 2 || measure.items.some((it) => it.kind === "chord" && it.pitches.length >= 2);
}

/** Offene Partitur: jedes System eine Stimme, Divisi als zusätzliche Stimme. */
function splitOpenScore(score: Score, names: string[]): [Voices, Flag[]] {
  const found = staves(score);
  if (found.length !== names.length) throw new LayoutError(`${found.length} Systeme gefunden, erwartet ${names.length}`);
  const voices: Voices = new Map();
  const flags: Flag[] = [];
  found.forEach((staff, i) => {
    const name = names[i];
    let main: NoteEvent[] = [];
    let divisi: NoteEvent[] = [];
    let divided = false;
    staff.measures.forEach((measure, idx) => {
      let up: NoteEvent[];
      let low: NoteEvent[];
      let f: Flag[];
      if (multiVoice(measure)) {
        [up, low, f] = splitMeasure(measure, idx, false);
        divided = divided || low.some((e) => e.midi !== null);
      } else {
        [up, f] = singleMeasure(measure, idx, name);
        low = up.map((e) => ({ ...e, source: "divisi" })); // ungeteilt: die untere Hälfte singt mit
      }
      main.push(...up);
      divisi.push(...low);
      flags.push(...f);
    });
    if (name.startsWith("Tenor") && plainTreble(staff)) {
      const lowerOctave = (e: NoteEvent) => (e.midi !== null ? { ...e, midi: e.midi - 12 } : e);
      main = main.map(lowerOctave);
      divisi = divisi.map(lowerOctave);
      flags.push({
        measure: 0, number: main.length ? main[0].number : "1", voice: name,
        reason: "Violinschlüssel ohne 8 erkannt, Tenor eine Oktave tiefer gesetzt",
      });
    }
    voices.set(name, main);
    if (divided) voices.set(`${name} 2`, divisi);
  });
  return [voices, flags];
}

function plainLength(it: Item): number {
  let length = it.ql;
  for (const [actual, normal] of it.tuplets) length /= normal / actual;
  return length;
}

/** Nimmt Triolen zurück, wenn der Takt mit ihnen zu kurz ist und ohne sie genau aufgeht.
 *  Audiveris hält Schrift wie „cresc.“ manchmal für eine Triolen-3. Ändert die Partitur. */
function repairTuplets(score: Score, labels: string[]): Flag[] {
  const flags: Flag[] = [];
  staves(score).slice(0, labels.length).forEach((staff, s) => {
    let ts: [number, number] | null = null;
    staff.measures.forEach((measure, idx) => {
      ts = measure.time ?? ts;
      if (ts === null) return;
      const bar = (ts[0] * 4) / ts[1];
      const groups = measure.voices.length ? measure.voices.map((v) => measure.items.filter((it) => it.voice === v)) : [measure.items.filter((it) => it.voice === null)];
      let changed = false;
      for (const group of groups) {
        const els = group.filter((it) => !it.grace);
        if (!els.some((it) => it.tuplets.length)) continue;
        let last = 0;
        let contiguous = true;
        for (const it of els) {
          contiguous = contiguous && Math.abs(it.offset - last) <= EPS;
          last = it.offset + it.ql;
        }
        const plain = els.reduce((sum, it) => sum + plainLength(it), 0);
        if (!contiguous || last >= bar - EPS || Math.abs(plain - bar) > EPS) continue;
        let offset = 0;
        for (const it of els) {
          const multiplier = it.tuplets.reduce((m, [actual, normal]) => m * (normal / actual), 1);
          const linked = it.typeQl !== null && Math.abs(it.typeQl * multiplier - it.ql) <= 1e-7;
          if (linked) it.ql = it.typeQl as number;
          it.tuplets = [];
          it.offset = offset;
          offset += it.ql;
        }
        changed = true;
        flags.push({ measure: idx, number: measure.number, voice: labels[s], reason: "Triole entfernt, der Takt ging mit ihr nicht auf" });
      }
      if (changed) measure.length = Math.max(measure.marksEnd, ...measure.items.map((it) => it.offset + it.ql));
    });
  });
  return flags;
}

export interface SplitResult {
  layout: string;
  voices: Voices;
  flags: Flag[];
}

/** Trennt die Partitur in Stimmen; layout "auto" erkennt die Besetzung an der Zahl der Systeme.
 *  Vorher werden falsch erkannte Triolen zurückgenommen. Die übergebene Partitur bleibt unverändert. */
export function splitScore(input: Score, layout = "auto"): SplitResult {
  const score: Score = structuredClone(input);
  const chosen = layout === "auto" ? detectLayout(score) : layout;
  if (chosen in OPEN_LAYOUTS || chosen === "benannt") {
    const names = chosen === "benannt" ? (namedVoices(score) as string[]) : OPEN_LAYOUTS[chosen];
    const repaired = repairTuplets(score, names);
    const [voices, flags] = splitOpenScore(score, names);
    return { layout: chosen, voices, flags: [...repaired, ...flags] };
  }
  const plan = LAYOUTS[chosen];
  if (!plan) throw new LayoutError(`Unbekannte Besetzung: ${chosen}`);
  const found = staves(score);
  if (found.length !== plan.length) {
    throw new LayoutError(`${found.length} Systeme gefunden, Vorlage ${chosen} erwartet ${plan.length}`);
  }
  const voices: Voices = new Map();
  const flags = repairTuplets(score, plan.map((pair) => pair.filter((n): n is string => !!n).join("/")));
  found.forEach((staff, i) => {
    const [top, bottom] = plan[i];
    const topEvents: NoteEvent[] = [];
    const bottomEvents: NoteEvent[] = [];
    staff.measures.forEach((measure, idx) => {
      const [up, low, f] = splitMeasure(measure, idx);
      topEvents.push(...up);
      bottomEvents.push(...low);
      flags.push(...f);
    });
    voices.set(top, topEvents);
    if (bottom !== null) voices.set(bottom, bottomEvents);
  });
  return { layout: chosen, voices, flags };
}
