// Plausibilitätsprüfung: markiert verdächtige Takte nach der Stimmentrennung.
//
// Geprüft wird, was bei Erkennungsfehlern typischerweise auffällt:
// - Taktlänge passt nicht zur Taktart (fehlender Taktstrich, fehlender Punkt)
// - Ton außerhalb des üblichen Stimmumfangs
// - Sprung größer als eine Oktave
// - Mehrere Noten einer Stimme fehlen und wurden aus der Nachbarstimme übernommen,
//   oder der ganze Takt einer Stimme stammt aus der Nachbarstimme
// - Ein Takt enthält in keiner Stimme eine Note (oft fehlende ganze Noten)
// - Eine Stimme pausiert einen ganzen Takt, während die anderen singen
// Auftakt und ein dazu passend verkürzter Schlusstakt gelten nicht als Fehler.
//
// Übertragen aus tools/omr/pruefung.py (privates Repository).

import { EPS, end, type Flag, type Voices } from "./model.ts";

/** Stimmumfang mit etwas Toleranz (MIDI): Sopran c′–a″, Alt f–e″, Tenor c–h′, Bass E–e′. */
export const RANGES: Record<string, [number, number]> = {
  Sopran: [60, 81],
  Alt: [53, 76],
  Tenor: [48, 71],
  Bass: [40, 64],
};

/** Zahl wie Pythons Format "g" (z. B. 5 statt 5.0, 4.5, 0.666667). */
export function formatG(x: number): string {
  return String(Number(x.toPrecision(6)));
}

/** {Stimme: {Takt-Index: Länge}}; Takte, in denen eine geteilte Stimme nur die
 *  ungeteilte mitsingt, fehlen (ihre Länge wird bei der Hauptstimme geprüft). */
function voiceLengths(voices: Voices): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const [name, events] of voices) {
    const lengths = new Map<number, number>();
    const filler = new Map<number, boolean>();
    for (const e of events) {
      lengths.set(e.measure, Math.max(lengths.get(e.measure) ?? 0, end(e)));
      filler.set(e.measure, (filler.get(e.measure) ?? true) && e.source === "divisi");
    }
    for (const [idx, onlyFiller] of filler) if (onlyFiller) lengths.delete(idx);
    out.set(name, lengths);
  }
  return out;
}

/** Liefert die Hinweise, nach Takt sortiert. bar = Taktlänge in Vierteln. */
export function check(voices: Voices, bar: number): Flag[] {
  const flags: Flag[] = [];
  const perVoice = voiceLengths(voices);
  const indices = [...new Set([...perVoice.values()].flatMap((l) => [...l.keys()]))].sort((a, b) => a - b);
  const numbers = new Map<number, string>();
  for (const events of voices.values()) for (const e of events) if (!numbers.has(e.measure)) numbers.set(e.measure, e.number);
  const uniform = new Map<number, number>();
  for (const i of indices) uniform.set(i, Math.max(...[...perVoice.values()].map((l) => l.get(i) ?? 0)));
  const expected = new Map<number, number>(indices.map((i) => [i, bar]));
  const u = (i: number) => uniform.get(i) as number;
  if (indices.length && u(indices[0]) < bar - EPS) {
    // Auftakt, der Schlusstakt darf ihn ergänzen
    expected.set(indices[0], u(indices[0]));
    const lastIdx = indices[indices.length - 1];
    if (Math.abs(u(lastIdx) + u(indices[0]) - bar) <= EPS) expected.set(lastIdx, u(lastIdx));
  }
  for (let k = 0; k + 1 < indices.length; k++) {
    // am Wiederholungszeichen geteilter Takt
    const a = indices[k];
    const b = indices[k + 1];
    const shortPair = u(a) < bar - EPS && u(b) < bar - EPS && Math.abs(u(a) + u(b) - bar) <= EPS;
    const sameNumber = numbers.get(a) === numbers.get(b) && u(a) <= bar + EPS && u(b) < bar - EPS;
    if (shortPair || sameNumber) {
      expected.set(a, u(a));
      expected.set(b, u(b));
    }
  }
  for (const idx of indices) {
    const exp = expected.get(idx) as number;
    const lengths = [...perVoice].filter(([, l]) => l.has(idx)).map(([name, l]) => [name, l.get(idx) as number] as const);
    const wrong = lengths.filter(([, n]) => Math.abs(n - exp) > EPS);
    const number = numbers.get(idx) as string;
    if (wrong.length && wrong.length === lengths.length && new Set(wrong.map(([, n]) => n)).size === 1) {
      flags.push({ measure: idx, number, voice: "alle", reason: `Takt hat ${formatG(wrong[0][1])} statt ${formatG(exp)} Viertel` });
    } else {
      for (const [name, length] of wrong) {
        flags.push({ measure: idx, number, voice: name, reason: `Stimme hat ${formatG(length)} statt ${formatG(exp)} Viertel` });
      }
    }
  }

  const sounding = new Set<number>();
  for (const events of voices.values()) for (const e of events) if (e.midi !== null) sounding.add(e.measure);
  for (const idx of indices) {
    if (!sounding.has(idx)) {
      flags.push({ measure: idx, number: numbers.get(idx) as string, voice: "alle", reason: "Takt ohne Noten, fehlen ganze Noten?" });
    }
  }

  // Einzelne Stimme still, die anderen singen: oft eine übersehene ganze Note. Gemeldet wird
  // nur ein Takt mitten im Singen (oder der Schlusstakt), nicht das Warten vor einem Einsatz
  // und nicht lange Pausen. Geteilte Stimmen (Divisi) singen nur stellenweise und zählen nicht.
  const main = [...voices].filter(([, events]) => !events.some((e) => e.source === "divisi")).map(([name]) => name);
  const sung = new Map(main.map((name) => [name, new Set((voices.get(name) ?? []).filter((e) => e.midi !== null).map((e) => e.measure))]));
  for (const idx of indices) {
    const silent = main.filter((name) => !(sung.get(name) as Set<number>).has(idx));
    if (!sounding.has(idx) || silent.length === 0 || (expected.get(idx) as number) < bar - EPS) continue;
    for (const name of silent) {
      const s = sung.get(name) as Set<number>;
      if (s.has(idx - 1) && (s.has(idx + 1) || idx === indices[indices.length - 1])) {
        flags.push({ measure: idx, number: numbers.get(idx) as string, voice: name, reason: "Stimme pausiert den ganzen Takt, fehlt eine ganze Note?" });
      }
    }
  }

  for (const [name, events] of voices) {
    const [low, high] = RANGES[name.trim().split(/\s+/)[0]] ?? [0, 127]; // "Bass 2" wie "Bass"
    const notes = events.filter((e) => e.midi !== null);
    for (const e of notes) {
      const midi = e.midi as number;
      if (!(low <= midi && midi <= high)) flags.push({ measure: e.measure, number: e.number, voice: name, reason: "Ton außerhalb des Stimmumfangs" });
    }
    for (let k = 0; k + 1 < notes.length; k++) {
      const a = notes[k];
      const b = notes[k + 1];
      if (Math.abs((b.midi as number) - (a.midi as number)) > 12 && !a.fermata) {
        // nach einer Fermate beginnt eine neue Phrase
        flags.push({ measure: b.measure, number: b.number, voice: name, reason: "Sprung größer als eine Oktave" });
      }
    }
    const copied = new Map<number, number>();
    for (const e of notes) if (e.source === "unison") copied.set(e.measure, (copied.get(e.measure) ?? 0) + 1);
    const own = new Set(events.filter((e) => e.source !== "unison").map((e) => e.measure));
    for (const [idx, count] of copied) {
      const number = numbers.get(idx) as string;
      if (!own.has(idx)) {
        flags.push({ measure: idx, number, voice: name, reason: "ganzer Takt aus der Nachbarstimme übernommen, fehlt eine eigene Note?" });
      } else if (count >= 3) {
        flags.push({ measure: idx, number, voice: name, reason: `${count} Noten fehlen, aus der Nachbarstimme übernommen` });
      }
    }
  }
  flags.sort((a, b) => a.measure - b.measure || (a.voice < b.voice ? -1 : a.voice > b.voice ? 1 : 0));
  return flags;
}
