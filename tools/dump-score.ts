// Gibt aus, wie die App eine MusicXML-Datei sieht, im selben JSON-Format wie
// dump_m21.py im privaten Repository (Abgleich mit dem Python-Prototyp).
// Aufruf: node tools/dump-score.ts datei.mxl
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { loadScore, type Score } from "../src/musicxml.ts";

const round = (x: number) => Math.round(x * 1e6) / 1e6;

export function dump(score: Score) {
  const singles = score.staffs.map((s, i) => [s, i] as const).filter(([s]) => !s.partStaff).map(([, i]) => i);
  return {
    parts: score.staffs.map((s) => ({
      name: s.name.trim(),
      partStaff: s.partStaff,
      clef: s.clef,
      measures: s.measures.map((m) => ({
        number: m.number,
        length: round(m.length),
        time: m.time ? `${m.time[0]}/${m.time[1]}` : null,
        voices: m.voices,
        multi: m.voices.length >= 2 || m.items.some((it) => it.kind === "chord" && it.pitches.length >= 2),
        items: m.items.map((it) => ({
          kind: it.kind,
          offset: round(it.offset),
          voice: it.voice,
          pitches: it.pitches,
          stem: it.stem,
          tie: it.tie,
          fermata: it.fermata,
          ql: round(it.ql),
          grace: it.grace,
          tuplets: it.tuplets,
        })),
      })),
    })),
    staves: singles.length ? singles : score.staffs.map((_, i) => i),
  };
}

if (process.argv[2]) {
  const score = loadScore(new Uint8Array(readFileSync(process.argv[2])), new DOMParser() as never);
  process.stdout.write(JSON.stringify(dump(score)));
}
