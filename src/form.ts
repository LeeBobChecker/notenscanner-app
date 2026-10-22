// Ablauf eines Stücks: Wiederholungen ausschreiben, Strophen aneinanderreihen.
//
// Die Wiederholungszeichen werden je Takt als "Form" gespeichert, getrennt von den
// Noten. So beziehen sich Korrekturen immer auf die gedruckten Takte, und erst beim
// Erzeugen der Übedateien wird der Ablauf ausgeschrieben.
//
// Übertragen aus tools/omr/ablauf.py (privates Repository).

import type { NoteEvent, Voices } from "./model.ts";
import type { Score } from "./musicxml.ts";

export interface Mark {
  start: boolean;
  end: boolean;
  times: number;
}

/** Wiederholungszeichen je Takt-Index, gelesen aus dem obersten System. */
export function measureForm(score: Score): Mark[] {
  const staff = score.staffs[0];
  if (!staff) return [];
  return staff.measures.map((m) => ({
    start: m.repeatStart,
    end: m.repeatEnd,
    times: (m.repeatEnd ? m.repeatTimes : null) || 2,
  }));
}

/** True, wenn es 1./2.-Klammern gibt (werden noch nicht ausgeschrieben). */
export function hasVoltas(score: Score): boolean {
  return score.staffs.some((s) => s.measures.some((m) => m.ending));
}

/** Reihenfolge der Takt-Indizes beim Abspielen, Wiederholungen ausgeschrieben. */
export function playOrder(form: Mark[]): number[] {
  const order: number[] = [];
  const counts = new Map<number, number>();
  let i = 0;
  let section = 0;
  while (i < form.length) {
    if (form[i].start) section = i;
    order.push(i);
    if (form[i].end) {
      const done = counts.get(i) ?? 1;
      if (done < (form[i].times ?? 2)) {
        counts.set(i, done + 1);
        i = section;
        continue;
      }
      section = i + 1;
    }
    i += 1;
  }
  return order;
}

/** Stimmen in Abspielreihenfolge; passes > 1 wiederholt das ganze Stück (Strophen). */
export function expand(voices: Voices, order: number[], passes = 1): Voices {
  const out: Voices = new Map();
  for (const [name, events] of voices) {
    const byMeasure = new Map<number, NoteEvent[]>();
    for (const e of events) {
      const list = byMeasure.get(e.measure) ?? [];
      list.push(e);
      byMeasure.set(e.measure, list);
    }
    const expanded: NoteEvent[] = [];
    let position = 0;
    for (let p = 0; p < passes; p++) {
      for (const idx of order) {
        for (const e of byMeasure.get(idx) ?? []) expanded.push({ ...e, measure: position });
        position += 1;
      }
    }
    out.set(name, expanded);
  }
  return out;
}
