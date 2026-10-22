// Liest die MusicXML-Datei aus Audiveris (.mxl oder .musicxml/.xml).
//
// Das Ergebnis bildet nach, wie der Python-Prototyp (music21) die Datei sieht:
// ein Eintrag je Notensystem ("Staff"; Teile mit zwei Systemen, etwa das Klavier,
// werden aufgeteilt), je Takt die Noten und Pausen mit Position, Stimmnummer,
// Halsrichtung, Haltebogen und Fermate. Mehrere Stimmen in einem Takt gibt es nur,
// wenn die Datei dort mehr als eine Stimmnummer verwendet. Auch die kleinen
// Reparaturen von music21 sind nachgebaut (leerer Takt, Ganztaktpause).

import { unzipSync } from "fflate";
import { pyRound, type Tie } from "./model.ts";

export interface Item {
  kind: "note" | "chord" | "rest";
  /** Position im Takt in Vierteln */
  offset: number;
  /** Stimmnummer, null wenn der Takt nur eine Stimme hat */
  voice: string | null;
  /** MIDI-Tonhöhen aufsteigend, leer bei Pausen */
  pitches: number[];
  /** "up", "down", "noStem", "double", "unspecified"; null bei Pausen */
  stem: string | null;
  tie: Tie;
  fermata: boolean;
  /** Dauer in Vierteln */
  ql: number;
  grace: boolean;
  /** [tatsächliche, normale] Notenzahl der Triole (time-modification) */
  tuplets: [number, number][];
  /** Dauer laut Notenwert und Punkten, ohne Triole (null ohne <type>) */
  typeQl: number | null;
}

export interface Measure {
  /** gedruckte Nummer, wie music21 sie bildet ("12", "12a") */
  number: string;
  /** Länge in Vierteln: Ende des letzten Elements */
  length: number;
  /** späteste Position einer Vortragsangabe (zählt für die Länge mit) */
  marksEnd: number;
  /** Taktart, wenn sie in diesem Takt am Anfang steht */
  time: [number, number] | null;
  /** Stimmnummern (leer, wenn der Takt nur eine Stimme hat) */
  voices: string[];
  items: Item[];
  repeatStart: boolean;
  repeatEnd: boolean;
  repeatTimes: number | null;
  /** 1./2.-Klammer beginnt oder endet hier */
  ending: boolean;
}

export interface Staff {
  name: string;
  /** Teil eines Teils mit mehreren Systemen (Klavier, Klammer) */
  partStaff: boolean;
  /** erster Schlüssel: [Zeichen, Oktavverschiebung] */
  clef: [string, number] | null;
  measures: Measure[];
}

export interface Score {
  title: string;
  staffs: Staff[];
  /** Tempo in Vierteln pro Minute, wenn die Datei eines angibt (<sound tempo>) */
  tempo: number | null;
}

/** Was DOMParser liefern muss (Browser oder @xmldom/xmldom in Tests). */
export interface XmlParser {
  parseFromString(text: string, type: string): Document;
}

const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const TYPE_QL: Record<string, number> = {
  maxima: 32, long: 16, breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5,
  "16th": 0.25, "32nd": 0.125, "64th": 0.0625, "128th": 0.03125, "256th": 0.015625,
  "512th": 0.0078125, "1024th": 0.00390625,
};

function kids(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n as Element);
  }
  return out;
}

function child(el: Element, name: string): Element | null {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.nodeName === name) return n as Element;
  }
  return null;
}

function children(el: Element, name: string): Element[] {
  return kids(el).filter((k) => k.nodeName === name);
}

function text(el: Element | null): string | null {
  if (!el) return null;
  const t = (el.textContent ?? "").trim();
  return t === "" ? null : t;
}

function childText(el: Element, name: string): string | null {
  return text(child(el, name));
}

function numberOr(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function tieOf(note: Element): Tie {
  const ties = children(note, "tie");
  if (ties.length === 0) return null;
  const types = ties.map((t) => t.getAttribute("type")).filter((t): t is string => !!t);
  if (types.length === 1) return types[0] as Tie;
  if (types.includes("start") && types.includes("stop")) return "continue";
  return "start";
}

function hasFermata(note: Element): boolean {
  return children(note, "notations").some((n) => child(n, "fermata") !== null);
}

function pitchOf(note: Element): number | null {
  const p = child(note, "pitch");
  if (!p) return null;
  const step = childText(p, "step") ?? "C";
  const octave = numberOr(childText(p, "octave"), 4);
  const alter = numberOr(childText(p, "alter"), 0);
  return pyRound((octave + 1) * 12 + (STEPS[step.toUpperCase()] ?? 0) + alter);
}

function stemOf(note: Element): string {
  const s = childText(note, "stem");
  if (s === null) return "unspecified";
  if (s === "none") return "noStem";
  return s;
}

interface RawNote {
  staff: number;
  voiceTag: string | null;
  /** Position und Ende in Vierteln, aus ganzen Teilschlägen berechnet wie in music21 */
  offset: number;
  end: number;
  ql: number;
  grace: boolean;
  rest: boolean;
  /** Akkord-Objekt (auch ein einzelner Ton mit <chord/>) */
  chord: boolean;
  pitches: number[];
  stem: string | null;
  tie: Tie;
  fermata: boolean;
  tuplets: [number, number][];
  type: string | null;
  dots: number;
  typeQl: number | null;
  /** Pause mit measure="yes" (ohne oder mit ganzem Notenwert) */
  fullMeasure: boolean;
  /** Stimme, in die music21 das Element setzt (null = direkt in den Takt) */
  voice: string | null;
  /** vom Einlesen ergänzte Pause, gehört allen Systemen und keiner Stimme */
  added: boolean;
  order: number;
}

interface RawMeasure {
  digits: number;
  suffix: string | null;
  number: string;
  notes: RawNote[];
  /** Positionen von Vortragsangaben, zählen für die Taktlänge */
  marks: { staff: number; offset: number }[];
  times: { staff: number; offset: number; value: [number, number] }[];
  clefs: { staff: number; offset: number; value: [string, number] }[];
  /** Systemnummern, die nur von Vorzeichen genannt werden */
  keyStaffs: number[];
  voiceIndices: Set<string>;
  repeatStart: boolean;
  repeatEnd: boolean;
  repeatTimes: number | null;
  ending: boolean;
}

function parseMeasure(el: Element, state: { divisions: number; staves: number }, order: { n: number }): RawMeasure {
  const raw = el.getAttribute("number");
  const digits = raw === null ? "" : raw.replace(/[^0-9]/g, "");
  const suffix = raw === null ? "" : raw.replace(/[0-9]/g, "");
  const m: RawMeasure = {
    digits: digits === "" ? 0 : parseInt(digits, 10),
    suffix: suffix === "" ? null : suffix,
    number: "",
    notes: [], marks: [], times: [], clefs: [], keyStaffs: [],
    voiceIndices: new Set(),
    repeatStart: false, repeatEnd: false, repeatTimes: null, ending: false,
  };
  // Position in Teilschlägen (divisions); wechselt die Einteilung mitten im Takt, wird umgerechnet.
  let pos = 0;
  let group: RawNote | null = null;
  const at = (p: number) => p / state.divisions;
  for (const c of kids(el)) {
    const name = c.nodeName;
    if (name !== "note") group = null;
    if (name === "attributes") {
      const div = childText(c, "divisions");
      if (div !== null && Number(div) > 0) {
        pos = (pos * Number(div)) / state.divisions;
        state.divisions = Number(div);
      }
      const staves = childText(c, "staves");
      if (staves !== null) state.staves = Math.max(state.staves, Number(staves));
      for (const k of children(c, "key")) {
        const n = numberOr(k.getAttribute("number"), 0);
        if (n !== 0) m.keyStaffs.push(n);
      }
      for (const t of children(c, "time")) {
        const beats = childText(t, "beats");
        const beatType = childText(t, "beat-type");
        if (beats !== null && beatType !== null && /^\d+$/.test(beats) && /^\d+$/.test(beatType)) {
          m.times.push({ staff: numberOr(t.getAttribute("number"), 0), offset: at(pos), value: [Number(beats), Number(beatType)] });
        }
      }
      for (const k of children(c, "clef")) {
        m.clefs.push({
          staff: numberOr(k.getAttribute("number"), 0),
          offset: at(pos),
          value: [childText(k, "sign") ?? "G", numberOr(childText(k, "clef-octave-change"), 0)],
        });
      }
    } else if (name === "note") {
      const voiceTag = childText(c, "voice");
      if (voiceTag !== null) m.voiceIndices.add(voiceTag);
      if (child(c, "unpitched")) {
        group = null;
        continue;
      }
      const midi = pitchOf(c);
      if (child(c, "chord") && group && !group.rest && midi !== null) {
        // weiterer Ton eines Akkords: zählt zur vorigen Note, keine eigene Position
        group.chord = true;
        group.pitches.push(midi);
        if (group.tie === null) group.tie = tieOf(c);
        if (group.voiceTag === null) group.voiceTag = voiceTag;
        group.fermata = group.fermata || hasFermata(c);
        continue;
      }
      const grace = child(c, "grace") !== null;
      const dur = grace ? 0 : numberOr(childText(c, "duration"), 0);
      const type = childText(c, "type");
      const dots = children(c, "dot").length;
      const typeQl = type !== null && TYPE_QL[type] !== undefined ? TYPE_QL[type] * (2 - 0.5 ** dots) : null;
      const mod = child(c, "time-modification");
      const tuplets: [number, number][] = [];
      if (mod && type !== null) {
        tuplets.push([numberOr(childText(mod, "actual-notes"), 1), numberOr(childText(mod, "normal-notes"), 1)]);
      }
      const restTag = child(c, "rest");
      const rest = restTag !== null || midi === null;
      const note: RawNote = {
        staff: numberOr(childText(c, "staff"), 0),
        voiceTag,
        offset: at(pos),
        end: at(pos + dur),
        ql: dur / state.divisions,
        grace,
        rest,
        chord: !rest && child(c, "chord") !== null,
        pitches: rest ? [] : [midi as number],
        stem: rest ? null : stemOf(c),
        tie: rest ? null : tieOf(c),
        fermata: hasFermata(c),
        tuplets,
        type,
        dots,
        typeQl,
        fullMeasure: rest && restTag?.getAttribute("measure") === "yes" && (type === null || type === "whole" || type === "breve"),
        voice: null,
        added: false,
        order: order.n++,
      };
      m.notes.push(note);
      group = note;
      if (!grace) pos += dur;
    } else if (name === "backup") {
      pos = Math.max(0, pos - numberOr(childText(c, "duration"), 0));
    } else if (name === "forward") {
      const voiceTag = childText(c, "voice");
      if (voiceTag !== null) m.voiceIndices.add(voiceTag);
      pos += numberOr(childText(c, "duration"), 0);
    } else if (name === "direction" || name === "harmony" || name === "figured-bass") {
      const shift = child(c, "offset");
      const extra = shift ? numberOr(text(shift), 0) : 0;
      m.marks.push({ staff: numberOr(childText(c, "staff"), 0), offset: at(pos + extra) });
    } else if (name === "barline") {
      const location = c.getAttribute("location") ?? "right";
      const repeat = child(c, "repeat");
      if (repeat) {
        const direction = repeat.getAttribute("direction");
        if (location === "left" && direction === "forward") m.repeatStart = true;
        if (location !== "left" && direction === "backward") {
          m.repeatEnd = true;
          const times = repeat.getAttribute("times");
          m.repeatTimes = times !== null && /^\d+$/.test(times) ? Number(times) : null;
        }
      }
      if (child(c, "ending")) m.ending = true;
    }
  }
  return m;
}

function byPosition(a: RawNote, b: RawNote): number {
  return a.offset - b.offset || Number(!a.grace) - Number(!b.grace) || a.order - b.order;
}

/** Stimmen zuordnen und die Reparaturen von music21 ausführen (ganzer Takt, vor dem Aufteilen in Systeme). */
function finishMeasure(m: RawMeasure, lastBar: number, order: { n: number }): void {
  const useVoices = m.voiceIndices.size > 1;
  let lastVoice: string | null = null;
  for (const n of m.notes) {
    if (!useVoices) continue;
    const voice: string = n.voiceTag ?? lastVoice ?? "1";
    lastVoice = voice;
    n.voice = m.voiceIndices.has(voice) ? voice : null;
  }

  // Ganztaktpause: genau eine Pause und keine Einzelnote, oder measure="yes"
  const plainNotes = m.notes.filter((n) => !n.rest && !n.chord).length;
  const rests = m.notes.filter((n) => n.rest);
  if (rests.some((r) => r.fullMeasure) || (rests.length === 1 && plainNotes === 0)) {
    const voiceOrder = useVoices ? [...m.voiceIndices].sort() : [];
    const inVoice = (v: string | null) => m.notes.filter((n) => n.rest && n.voice === v).sort(byPosition);
    const r1 = [...voiceOrder.flatMap((v) => inVoice(v)), ...inVoice(null)][0];
    if (r1) {
      let type = r1.type;
      let dots = r1.dots;
      if (type === null) {
        type = r1.ql === 4 ? "whole" : r1.ql === 8 ? "breve" : "other";
        dots = 0;
      }
      const wholeLike = (type === "whole" || type === "breve") && dots === 0 && r1.tuplets.length === 0;
      if (r1.fullMeasure || (r1.ql !== lastBar && wholeLike)) {
        r1.ql = lastBar;
        r1.end = r1.offset + lastBar;
      }
    }
  }

  // Leerer Takt: eine Pause über den ganzen Takt
  const highest = Math.max(0, ...m.notes.map((n) => n.end), ...m.marks.map((k) => k.offset));
  if (m.notes.length === 0 && highest === 0) {
    m.notes.push({
      staff: 0, voiceTag: null, offset: 0, end: lastBar, ql: lastBar, grace: false, rest: true, chord: false,
      pitches: [], stem: null, tie: null, fermata: false, tuplets: [], type: null, dots: 0, typeQl: null,
      fullMeasure: false, voice: null, added: true, order: order.n++,
    });
  }
}

function toItem(n: RawNote, voice: string | null): Item {
  return {
    kind: n.rest ? "rest" : n.chord ? "chord" : "note",
    offset: n.offset,
    voice,
    pitches: n.pitches.slice().sort((a, b) => a - b),
    stem: n.rest ? null : n.chord ? "unspecified" : n.stem,
    tie: n.tie,
    fermata: n.fermata,
    ql: n.ql,
    grace: n.grace,
    tuplets: n.tuplets,
    typeQl: n.typeQl,
  };
}

function staffMeasure(raw: RawMeasure, staffKey: number | null): Measure {
  const belongs = (staff: number) => staffKey === null || staff === staffKey || staff === 0;
  const notes = raw.notes.filter((n) => n.added || belongs(n.staff));
  const useVoices = raw.voiceIndices.size > 1;
  const voiceIds = useVoices ? [...raw.voiceIndices].sort() : [];
  const byVoice = new Map(voiceIds.map((v) => [v, notes.filter((n) => n.voice === v)]));

  let voices = voiceIds;
  let direct = notes.filter((n) => n.voice === null);
  if (staffKey !== null && useVoices) {
    // Teil mit mehreren Systemen: leere Stimmen fallen weg, eine einzelne wird aufgelöst.
    voices = voiceIds.filter((v) => (byVoice.get(v) ?? []).length > 0);
    if (voices.length === 1) {
      direct = [...direct, ...(byVoice.get(voices[0]) ?? [])];
      voices = [];
    }
  }
  const items = direct.slice().sort(byPosition).map((n) => toItem(n, null));
  for (const v of voices) items.push(...(byVoice.get(v) ?? []).slice().sort(byPosition).map((n) => toItem(n, v)));

  let marksEnd = 0;
  for (const mark of raw.marks) if (belongs(mark.staff)) marksEnd = Math.max(marksEnd, mark.offset);
  let length = marksEnd;
  for (const n of notes) length = Math.max(length, n.end);
  const time = raw.times.find((t) => belongs(t.staff) && t.offset === 0);
  return {
    number: raw.number,
    length,
    marksEnd,
    time: time ? time.value : null,
    voices,
    items,
    repeatStart: raw.repeatStart,
    repeatEnd: raw.repeatEnd,
    repeatTimes: raw.repeatTimes,
    ending: raw.ending,
  };
}

function staffKeys(raws: RawMeasure[]): number[] {
  const keys = new Set<number>();
  for (const r of raws) {
    for (const n of r.notes) if (n.staff !== 0) keys.add(n.staff);
    for (const c of r.clefs) if (c.staff !== 0) keys.add(c.staff);
    for (const t of r.times) if (t.staff !== 0) keys.add(t.staff);
    for (const k of r.marks) if (k.staff !== 0) keys.add(k.staff);
    for (const k of r.keyStaffs) keys.add(k);
  }
  return [...keys].sort((a, b) => a - b);
}

/** Liest eine MusicXML-Datei (score-partwise). */
export function parseMusicXml(xml: string, parser: XmlParser): Score {
  const doc = parser.parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (!root || root.nodeName === "parsererror" || doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Die Datei ist keine lesbare MusicXML-Datei.");
  }
  if (root.nodeName === "score-timewise") {
    throw new Error("Diese MusicXML-Variante (score-timewise) wird nicht unterstützt.");
  }
  if (root.nodeName !== "score-partwise") {
    throw new Error("Die Datei ist keine MusicXML-Partitur.");
  }
  const work = child(root, "work");
  const title = childText(root, "movement-title") ?? (work ? childText(work, "work-title") : null) ?? "";
  const names = new Map<string, string>();
  const list = child(root, "part-list");
  if (list) {
    for (const sp of children(list, "score-part")) {
      names.set(sp.getAttribute("id") ?? "", childText(sp, "part-name") ?? "");
    }
  }
  const staffs: Staff[] = [];
  const order = { n: 0 };
  let tempo: number | null = null;
  for (const sound of Array.from(root.getElementsByTagName("sound"))) {
    const value = Number(sound.getAttribute("tempo"));
    if (value > 0) {
      tempo = value;
      break;
    }
  }
  for (const part of children(root, "part")) {
    const name = names.get(part.getAttribute("id") ?? "") ?? "";
    const state = { divisions: 1, staves: 1 };
    const raws: RawMeasure[] = [];
    let lastNumber = 0;
    let lastSuffix: string | null = null;
    let lastBar: number | null = null;
    for (const el of children(part, "measure")) {
      const m = parseMeasure(el, state, order);
      // Taktnummern wie music21 (dort für Finale: "X1" usw. hinter der vorigen Nummer)
      if (m.suffix === "X" && m.digits !== lastNumber + 1) {
        m.suffix = (lastSuffix ?? "") + "X" + m.digits;
        m.digits = lastNumber;
      }
      m.number = `${m.digits}${m.suffix ?? ""}`;
      if (m.digits !== lastNumber) {
        lastNumber = m.digits;
        lastSuffix = m.suffix;
      }
      const time = m.times.find((t) => t.offset === 0);
      if (time) lastBar = (time.value[0] * 4) / time.value[1];
      else if (lastBar === null) lastBar = 4;
      finishMeasure(m, lastBar, order);
      raws.push(m);
    }
    const keys = state.staves > 1 ? staffKeys(raws) : [null];
    for (const key of keys) {
      const measures = raws.map((raw) => staffMeasure(raw, key));
      let clef: [string, number] | null = null;
      for (const raw of raws) {
        const c = raw.clefs.find((k) => key === null || k.staff === key || k.staff === 0);
        if (c) {
          clef = c.value;
          break;
        }
      }
      staffs.push({ name, partStaff: key !== null, clef, measures });
    }
  }
  return { title, staffs, tempo };
}

/** Text aus Bytes; MusicXML ist meist UTF-8, manchmal UTF-16 mit Byte-Order-Mark. */
function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

/** Liest .mxl (gepackt) oder .musicxml/.xml. */
export function loadScore(bytes: Uint8Array, parser: XmlParser): Score {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) return parseMusicXml(decode(bytes), parser);
  const files = unzipSync(bytes);
  let rootPath: string | null = null;
  const container = files["META-INF/container.xml"];
  if (container) {
    const doc = parser.parseFromString(decode(container), "application/xml");
    const rootfile = doc.getElementsByTagName("rootfile")[0];
    rootPath = rootfile ? rootfile.getAttribute("full-path") : null;
  }
  if (!rootPath || !files[rootPath]) {
    rootPath = Object.keys(files).find((f) => !f.startsWith("META-INF/") && /\.(xml|musicxml)$/i.test(f)) ?? null;
  }
  if (!rootPath) throw new Error("In der .mxl-Datei steckt keine Partitur.");
  return parseMusicXml(decode(files[rootPath]), parser);
}
