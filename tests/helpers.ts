// Kleine MusicXML-Partituren für die Tests, so wie Audiveris sie schreibt.

import { DOMParser } from "@xmldom/xmldom";
import { parseNotes } from "../src/corrections.ts";
import { event, type NoteEvent } from "../src/model.ts";
import { parseMusicXml, type Score } from "../src/musicxml.ts";

/** Tonhöhe (z. B. "C#4") oder Akkord (["E4", "G4"]) oder Pause (null), Dauer in Vierteln, Hals */
export type Spec = [string | string[] | null, number, ("up" | "down" | null)?];
/** je Takt eine Liste von Stimmen, jede Stimme eine Liste von Noten */
export type MeasureSpec = Spec[][];

export interface PartSpec {
  name?: string;
  clef?: [string, number, number?]; // Zeichen, Linie, Oktavverschiebung
  measures: MeasureSpec[];
  time?: [number, number];
}

const DIV = 6;
const TYPES: Record<number, string> = { 4: "whole", 3: "half", 2: "half", 1.5: "quarter", 1: "quarter", 0.5: "eighth", 0.25: "16th" };

function pitchXml(p: string): string {
  const m = /^([A-G])(#|b)?(\d)$/.exec(p);
  if (!m) throw new Error(p);
  const alter = m[2] === "#" ? "<alter>1</alter>" : m[2] === "b" ? "<alter>-1</alter>" : "";
  return `<pitch><step>${m[1]}</step>${alter}<octave>${m[3]}</octave></pitch>`;
}

function noteXml([pitch, length, stem]: Spec, voice: number): string {
  const dur = `<duration>${Math.round(length * DIV)}</duration><voice>${voice}</voice>`;
  const type = TYPES[length] ? `<type>${TYPES[length]}</type>` : "";
  const dot = length === 3 || length === 1.5 ? "<dot/>" : "";
  const stemXml = stem ? `<stem>${stem}</stem>` : "";
  if (pitch === null) return `<note><rest/>${dur}${type}${dot}</note>`;
  const pitches = Array.isArray(pitch) ? pitch : [pitch];
  return pitches
    .map((p, i) => `<note>${i ? "<chord/>" : ""}${pitchXml(p)}${dur}${type}${dot}${stemXml}</note>`)
    .join("");
}

export function scoreXml(parts: PartSpec[]): string {
  const list = parts.map((p, i) => `<score-part id="P${i + 1}"><part-name>${p.name ?? "Voice"}</part-name></score-part>`).join("");
  const body = parts
    .map((p, i) => {
      const [sign, line, octave] = p.clef ?? ["G", 2];
      const [beats, beatType] = p.time ?? [2, 4];
      const measures = p.measures
        .map((voices, m) => {
          const attrs = m === 0
            ? `<attributes><divisions>${DIV}</divisions><key><fifths>0</fifths></key><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>` +
              `<clef><sign>${sign}</sign><line>${line}</line>${octave ? `<clef-octave-change>${octave}</clef-octave-change>` : ""}</clef></attributes>`
            : "";
          const content = voices
            .map((specs, v) => {
              const length = specs.reduce((sum, s) => sum + s[1], 0);
              const backup = v < voices.length - 1 ? `<backup><duration>${Math.round(length * DIV)}</duration></backup>` : "";
              return specs.map((s) => noteXml(s, v + 1)).join("") + backup;
            })
            .join("");
          return `<measure number="${m + 1}">${attrs}${content}</measure>`;
        })
        .join("");
      return `<part id="P${i + 1}">${measures}</part>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><part-list>${list}</part-list>${body}</score-partwise>`;
}

export function parse(xml: string): Score {
  return parseMusicXml(xml, new DOMParser() as never);
}

export function score(parts: PartSpec[]): Score {
  return parse(scoreXml(parts));
}

/** Stimme aus Takten in Textschreibweise, Takte ab 1 nummeriert. */
export function voice(...measures: string[]): NoteEvent[] {
  const events: NoteEvent[] = [];
  measures.forEach((text, idx) => {
    let offset = 0;
    for (const [midi, dur, tie] of parseNotes(text)) {
      events.push(event(idx, String(idx + 1), offset, dur, midi, "stem", tie));
      offset += dur;
    }
  });
  return events;
}
