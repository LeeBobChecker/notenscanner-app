// MIDI-Dateien für die Übedateien: eine Spur je Stimme, gleichmäßiges Tempo,
// kein Vorspann (Wünsche des Nutzers: kein Starton, kein Einzähler, Fermaten ignorieren).
//
// Varianten:
//   solo    nur die eigene Stimme
//   mix     die eigene Stimme laut in der Mitte (Klavier), die anderen leise und
//           seitlich (Streicher)
//   gesamt  alle Stimmen gleich laut (Klavier), von links (Sopran) nach rechts (Bass)
//
// Übertragen aus tools/omr/render_practice.py (privates Repository); die Bytes
// stimmen mit den Dateien des Prototyps überein.

import { end, pyRound, type NoteEvent, type Voices } from "./model.ts";

export type Mode = "solo" | "mix" | "gesamt";

const TPQ = 480; // MIDI-Ticks pro Viertel
const PIANO = 0;
const STRINGS = 48;

/** Startzeit (in Vierteln) jedes Takt-Index über alle Stimmen. */
export function timeline(voices: Voices): { starts: Map<number, number>; total: number } {
  const lengths = new Map<number, number>();
  for (const events of voices.values()) {
    for (const e of events) lengths.set(e.measure, Math.max(lengths.get(e.measure) ?? 0, end(e)));
  }
  const starts = new Map<number, number>();
  let t = 0;
  for (const idx of [...lengths.keys()].sort((a, b) => a - b)) {
    starts.set(idx, t);
    t += lengths.get(idx) as number;
  }
  return { starts, total: t };
}

/** (Beginn, Dauer, Tonhöhe) in Vierteln; Haltebögen zusammengefasst. Nach einem begonnenen
 *  Haltebogen gehört die nächste Note gleicher Höhe dazu, auch wenn die Erkennung ihr
 *  Bogenende nicht oder falsch markiert hat. */
export function notesOf(events: NoteEvent[], starts: Map<number, number>): [number, number, number][] {
  const out: [number, number, number][] = [];
  let hold: [number, number, number] | null = null;
  for (const e of events) {
    const start = (starts.get(e.measure) as number) + e.offset;
    if (e.midi === null) {
      hold = null;
      continue;
    }
    if (hold !== null && hold[2] === e.midi) {
      hold[1] = start + e.duration - hold[0];
    } else {
      hold = [start, e.duration, e.midi];
      out.push(hold);
    }
    if (e.tie !== "start" && e.tie !== "continue") hold = null;
  }
  return out;
}

type Message = { meta: true; bytes: number[] } | { meta: false; type: "on" | "off" | "other"; bytes: number[] };

function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

function meta(type: number, data: number[]): Message {
  return { meta: true, bytes: [0xff, type, ...vlq(data.length), ...data] };
}

function latin1(text: string): number[] {
  return [...text].map((c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f));
}

/** Zeitpunkte (in Vierteln) in Delta-Ticks umrechnen, wie im Prototyp sortiert. */
function track(timed: [number, Message][]): number[] {
  const sorted = timed
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const ka = a.entry[1].meta === false && a.entry[1].type === "off" ? 0 : 1;
      const kb = b.entry[1].meta === false && b.entry[1].type === "off" ? 0 : 1;
      return a.entry[0] - b.entry[0] || ka - kb || a.i - b.i;
    })
    .map(({ entry }) => entry);
  const data: number[] = [];
  let last = 0;
  let running: number | null = null;
  for (const [t, msg] of sorted) {
    const tick = pyRound(t * TPQ);
    data.push(...vlq(Math.max(tick - last, 0)));
    last = Math.max(tick, last);
    if (msg.meta) {
      data.push(...msg.bytes);
      running = null;
    } else {
      const status = msg.bytes[0];
      data.push(...(status === running ? msg.bytes.slice(1) : msg.bytes));
      running = status < 0xf0 ? status : null;
    }
  }
  data.push(0x00, 0xff, 0x2f, 0x00); // Spurende
  return data;
}

function chunk(name: string, data: number[]): number[] {
  const n = data.length;
  return [...latin1(name), (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...data];
}

function note(start: number, dur: number, pitch: number, channel: number, velocity: number): [number, Message][] {
  const stop = start + Math.max(dur - 0.02, 0.05); // minimal absetzen, damit Tonwiederholungen hörbar sind
  return [
    [start, { meta: false, type: "on", bytes: [0x90 | channel, pitch, velocity] }],
    [stop, { meta: false, type: "off", bytes: [0x80 | channel, pitch, 0] }],
  ];
}

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

/** MIDI-Datei (Typ 1) für eine Stimme und Variante; target = null bei "gesamt". */
export function buildMidi(
  voices: Voices,
  starts: Map<number, number>,
  target: string | null,
  mode: Mode,
  bpm: number,
  ts: TimeSignature,
): Uint8Array {
  const names = [...voices.keys()];
  if (mode !== "gesamt" && !names.includes(target as string)) {
    throw new Error(`Stimme '${target}' nicht gefunden: ${names.join(", ")}`);
  }
  const tracks: number[][] = [];
  const tempo = pyRound(((60 * 1e6) / bpm) * 4 / 4);
  const timeSig = meta(0x58, [ts.numerator, Math.round(Math.log2(ts.denominator)), 24, 8]);
  const header = [0x00, ...timeSig.bytes];
  tracks.push([...header, ...track([[0, meta(0x51, [(tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff])]])]);

  let channel = 0;
  names.forEach((name, index) => {
    if (mode === "solo" && name !== target) return;
    const own = name === target;
    let events = voices.get(name) as NoteEvent[];
    if (!own) events = events.filter((e) => e.source !== "divisi"); // gemeinsame Takte nicht doppelt
    let program: number;
    let volume: number;
    let pan: number;
    if (mode === "gesamt") {
      program = PIANO;
      volume = 100;
      pan = pyRound(24 + (80 * index) / Math.max(names.length - 1, 1));
    } else {
      program = own ? PIANO : STRINGS;
      volume = own || mode === "solo" ? 120 : 50;
      pan = own ? 64 : index % 2 === 0 ? 30 : 98;
    }
    const msgs: [number, Message][] = [
      [0, meta(0x03, latin1(name))],
      [0, { meta: false, type: "other", bytes: [0xc0 | channel, program] }],
      [0, { meta: false, type: "other", bytes: [0xb0 | channel, 7, volume] }],
      [0, { meta: false, type: "other", bytes: [0xb0 | channel, 10, pan] }],
    ];
    for (const [start, dur, pitch] of notesOf(events, starts)) msgs.push(...note(start, dur, pitch, channel, own ? 96 : 80));
    tracks.push(track(msgs));
    channel += 1;
    if (channel === 9) channel = 10; // Kanal 10 ist Schlagzeug
  });

  const head = chunk("MThd", [0, 1, (tracks.length >> 8) & 0xff, tracks.length & 0xff, (TPQ >> 8) & 0xff, TPQ & 0xff]);
  const body = tracks.flatMap((t) => chunk("MTrk", t));
  return new Uint8Array([...head, ...body]);
}
