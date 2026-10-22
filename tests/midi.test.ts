import { describe, expect, it } from "vitest";
import { buildMidi, notesOf, timeline, type Mode } from "../src/midi.ts";
import { event, type NoteEvent, type Tie, type Voices } from "../src/model.ts";

/** je Takt eine Liste von (Tonhöhe oder null, Dauer, Bogen) */
function v(...measures: [number | null, number, Tie][][]): NoteEvent[] {
  const out: NoteEvent[] = [];
  measures.forEach((notes, idx) => {
    let offset = 0;
    for (const [midi, dur, tie] of notes) {
      out.push(event(idx, String(idx + 1), offset, dur, midi, "stem", tie));
      offset += dur;
    }
  });
  return out;
}

describe("Haltebögen", () => {
  it("verbindet über den Taktstrich", () => {
    const voice = v([[74, 4, "start"]], [[74, 2, "stop"], [72, 2, null]]);
    const { starts } = timeline(new Map([["Sopran", voice]]));
    expect(notesOf(voice, starts)).toEqual([[0, 6, 74], [6, 2, 72]]);
  });

  it("verträgt ein falsch markiertes Bogenende", () => {
    const voice = v([[74, 4, "start"]], [[74, 2, "start"], [72, 2, null]]);
    const { starts } = timeline(new Map([["Sopran", voice]]));
    expect(notesOf(voice, starts)).toEqual([[0, 6, 74], [6, 2, 72]]);
  });

  it("schlägt ohne Bogen neu an", () => {
    const voice = v([[74, 4, null]], [[74, 4, null]]);
    const { starts } = timeline(new Map([["Sopran", voice]]));
    expect(notesOf(voice, starts)).toEqual([[0, 4, 74], [4, 4, 74]]);
  });
});

/** Liest Spurname, Lautstärke und angeschlagene Töne je Spur zurück. */
function readTracks(bytes: Uint8Array) {
  const tracks: { name: string; volume: number; notes: number[] }[] = [];
  let p = 14;
  while (p < bytes.length) {
    const len = (bytes[p + 4] << 24) | (bytes[p + 5] << 16) | (bytes[p + 6] << 8) | bytes[p + 7];
    const end = p + 8 + len;
    let q = p + 8;
    let status = 0;
    const t = { name: "", volume: -1, notes: [] as number[] };
    while (q < end) {
      while (bytes[q] & 0x80) q++; // Delta-Zeit
      q++;
      if (bytes[q] === 0xff) {
        const type = bytes[q + 1];
        const n = bytes[q + 2];
        if (type === 0x03) t.name = String.fromCharCode(...bytes.slice(q + 3, q + 3 + n));
        q += 3 + n;
        continue;
      }
      if (bytes[q] & 0x80) status = bytes[q++];
      const kind = status & 0xf0;
      const size = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      const [a, b] = [bytes[q], bytes[q + 1]];
      if (kind === 0x90 && b > 0) t.notes.push(a);
      if (kind === 0xb0 && a === 7) t.volume = b;
      q += size;
    }
    tracks.push(t);
    p = end;
  }
  return tracks.slice(1);
}

function divisiMix(target: string | null, mode: Mode) {
  const bass = v([[50, 4, null]], [[48, 4, null]]);
  const bass2 = v([[50, 4, null]], [[45, 4, null]]);
  bass2[0].source = "divisi"; // ungeteilter Takt, nur mitgesungen
  const voices: Voices = new Map([["Sopran", v([[72, 4, null]], [[74, 4, null]])], ["Bass", bass], ["Bass 2", bass2]]);
  const { starts } = timeline(voices);
  return readTracks(buildMidi(voices, starts, target, mode, 80, { numerator: 4, denominator: 4 }));
}

describe("Varianten", () => {
  it("Gesamtfassung: alle gleich laut, gemeinsame Takte nicht doppelt", () => {
    const tracks = divisiMix(null, "gesamt");
    expect(Object.fromEntries(tracks.map((t) => [t.name, t.notes]))).toEqual({ Sopran: [72, 74], Bass: [50, 48], "Bass 2": [45] });
    expect(new Set(tracks.map((t) => t.volume))).toEqual(new Set([100]));
  });

  it("Übe-Mix: eigene Stimme vollständig, Begleitung nicht doppelt", () => {
    expect(divisiMix("Bass 2", "mix").find((t) => t.name === "Bass 2")?.notes).toEqual([50, 45]);
    const tracks = divisiMix("Sopran", "mix");
    expect(Object.fromEntries(tracks.map((t) => [t.name, t.notes]))).toEqual({ Sopran: [72, 74], Bass: [50, 48], "Bass 2": [45] });
    expect(tracks.map((t) => t.volume)).toEqual([120, 50, 50]);
  });

  it("Solo: nur die eigene Stimme", () => {
    expect(divisiMix("Bass", "solo").map((t) => t.name)).toEqual(["Bass"]);
  });
});
