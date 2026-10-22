// Gemeinsame Datentypen: Ereignisse einer Stimme und Hinweise der Prüfung.

export type Tie = "start" | "stop" | "continue" | null;

/** Eine Note oder Pause einer einzelnen Stimme. */
export interface NoteEvent {
  /** laufender Takt-Index ab 0 (nicht die gedruckte Nummer) */
  measure: number;
  /** gedruckte Taktnummer laut Erkennung */
  number: string;
  /** Position im Takt in Vierteln */
  offset: number;
  /** Dauer in Vierteln */
  duration: number;
  /** MIDI-Tonhöhe, null = Pause */
  midi: number | null;
  tie: Tie;
  fermata: boolean;
  /** wie die Zuordnung zustande kam: stem, chord, voice, pitch, single, unison, gap, divisi, korrektur */
  source: string;
}

/** Hinweis auf eine verdächtige Stelle. */
export interface Flag {
  measure: number;
  number: string;
  voice: string;
  reason: string;
}

/** Stimmen in fester Reihenfolge (Sopran zuerst). */
export type Voices = Map<string, NoteEvent[]>;

export const EPS = 1e-6;

export function end(e: NoteEvent): number {
  return e.offset + e.duration;
}

export function event(
  measure: number,
  number: string,
  offset: number,
  duration: number,
  midi: number | null,
  source: string,
  tie: Tie = null,
  fermata = false,
): NoteEvent {
  return { measure, number, offset, duration, midi, tie, fermata, source };
}

/** Rundet wie Python (bei genau ,5 zur geraden Zahl), damit Ergebnisse mit dem Prototyp übereinstimmen. */
export function pyRound(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x - Math.trunc(x)) === 0.5) {
    return 2 * Math.round(x / 2);
  }
  return r;
}
