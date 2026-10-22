import { describe, expect, it } from "vitest";
import type { NoteEvent } from "../src/model.ts";
import { detectLayout, splitScore } from "../src/split.ts";
import { parse, score, type MeasureSpec } from "./helpers.ts";

const pitches = (events: NoteEvent[] | undefined) => (events ?? []).map((e) => [e.midi, e.duration]);
const BASS_LINE: MeasureSpec[] = [[[["C3", 1, "up"], ["D3", 1, "up"]], [["C2", 1, "down"], ["D2", 1, "down"]]]];

function closed(upper: MeasureSpec[], lower: MeasureSpec[] = BASS_LINE) {
  return splitScore(score([{ measures: upper }, { clef: ["F", 4], measures: lower }]));
}

describe("geschlossener Satz", () => {
  it("trennt die Stimmen nach der Halsrichtung", () => {
    const { voices, flags } = closed([[[["G4", 1, "up"], ["A4", 1, "up"]], [["E4", 1, "down"], ["F4", 1, "down"]]]]);
    expect(pitches(voices.get("Sopran"))).toEqual([[67, 1], [69, 1]]);
    expect(pitches(voices.get("Alt"))).toEqual([[64, 1], [65, 1]]);
    expect(pitches(voices.get("Tenor"))).toEqual([[48, 1], [50, 1]]);
    expect(pitches(voices.get("Bass"))).toEqual([[36, 1], [38, 1]]);
    expect(flags).toEqual([]);
  });

  it("teilt einen Akkord an einem Hals", () => {
    const { voices } = closed([[[[["E4", "G4"], 1, "up"], [["F4", "A4"], 1, "up"]]]]);
    expect(voices.get("Sopran")?.map((e) => e.midi)).toEqual([67, 69]);
    expect(voices.get("Alt")?.map((e) => e.midi)).toEqual([64, 65]);
  });

  it("kopiert ein Unisono in die andere Stimme", () => {
    const { voices } = closed([[[["G4", 2, "up"]]]]);
    expect(pitches(voices.get("Alt"))).toEqual([[67, 2]]);
    expect(voices.get("Alt")?.[0].source).toBe("unison");
  });

  it("macht aus einer Pause kein Unisono", () => {
    const { voices } = closed([[[["G4", 2, "up"]], [[null, 2]]]]);
    expect(pitches(voices.get("Alt"))).toEqual([[null, 2]]);
  });

  it("markiert einen Akkord mit drei Tönen", () => {
    const { voices, flags } = closed([[[[["E4", "G4", "C5"], 2, "up"]]]]);
    expect(voices.get("Sopran")?.map((e) => e.midi)).toEqual([72]);
    expect(voices.get("Alt")?.map((e) => e.midi)).toEqual([64]);
    expect(flags.some((f) => f.reason.includes("Stimmteilung"))).toBe(true);
  });
});

function open(tenorClef: [string, number, number?]) {
  // Wie die Erkennung es liefert: mit erkannter kleiner 8 klingende Tonhöhe (e, c),
  // mit übersehener 8 eine Oktave zu hoch gelesen (e', c').
  const tenor = tenorClef[2] ? ["E3", "C3"] : ["E4", "C4"];
  return score([
    { measures: [[[["C5", 1, "down"], ["E4", 1, "up"]]]] },
    { measures: [[[["G4", 2, "up"]]]] },
    { clef: tenorClef, measures: [[[[tenor[0], 1, "down"], [tenor[1], 1, "up"]]]] },
    { clef: ["F", 4], measures: [[[["C3", 1, "up"]], [["A2", 1, "down"], [null, 1]]]] },
  ]);
}

describe("offene Partitur", () => {
  it("wird an vier Systemen erkannt", () => {
    expect(detectLayout(open(["G", 2, -1]))).toBe("SATB-offen");
  });

  it("achtet nicht auf die Halsrichtung", () => {
    const { voices } = splitScore(open(["G", 2, -1]));
    expect(voices.get("Sopran")?.map((e) => e.midi)).toEqual([72, 64]);
    expect(voices.get("Tenor")?.map((e) => e.midi)).toEqual([52, 48]);
  });

  it("setzt einen Tenor im Violinschlüssel ohne 8 eine Oktave tiefer", () => {
    const { voices, flags } = splitScore(open(["G", 2]));
    expect(voices.get("Tenor")?.map((e) => e.midi)).toEqual([52, 48]);
    expect(flags.some((f) => f.reason.includes("Oktave tiefer"))).toBe(true);
  });

  it("macht aus einem geteilten Bass eine zweite Stimme", () => {
    const { voices } = splitScore(open(["G", 2, -1]));
    expect(pitches(voices.get("Bass"))).toEqual([[48, 1], [null, 1]]);
    expect(pitches(voices.get("Bass 2"))).toEqual([[45, 1], [null, 1]]);
    expect(voices.has("Alt 2")).toBe(false);
  });

  it("lässt die untere Hälfte in ungeteilten Takten mitsingen", () => {
    const { voices } = splitScore(divisi(true));
    expect(voices.get("Bass")?.filter((e) => e.midi).map((e) => [e.measure, e.midi])).toEqual([[0, 50], [1, 48]]);
    expect(voices.get("Bass 2")?.filter((e) => e.midi).map((e) => [e.measure, e.midi, e.source])).toEqual([[0, 50, "divisi"], [1, 45, "stem"]]);
  });

  it("legt ohne Teilung keine zweite Stimme an", () => {
    const { voices } = splitScore(divisi(false));
    expect([...voices.keys()].sort()).toEqual(["Alt", "Bass", "Sopran", "Tenor"]);
  });
});

/** Bass mit zwei 2/4-Takten; im zweiten auf Wunsch geteilt (zwei Stimmen). */
function divisi(divided: boolean) {
  const second: MeasureSpec = divided ? [[["C3", 2, "up"]], [["A2", 2, "down"]]] : [[["C3", 2]]];
  return score([
    { measures: [[[["C5", 2]]], [[["D5", 2]]]] },
    { measures: [[[["G4", 2]]], [[["A4", 2]]]] },
    { clef: ["G", 2, -1], measures: [[[["E3", 2]]], [[["F3", 2]]]] },
    { clef: ["F", 4], measures: [[[["D3", 2]]], second] },
  ]);
}

function triplets(soprano: [string, boolean][]) {
  const note = ([p, triplet]: [string, boolean]) =>
    `<note><pitch><step>${p[0]}</step><octave>${p[1]}</octave></pitch><duration>${triplet ? 4 : 6}</duration><voice>1</voice><type>quarter</type>` +
    (triplet ? "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>" : "") +
    "</note>";
  const clefs = ["<sign>G</sign><line>2</line>", "<sign>G</sign><line>2</line>", "<sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change>", "<sign>F</sign><line>4</line>"];
  const others = [null, "C4", "C4", "C3"];
  const parts = clefs.map((clef, i) => {
    const notes = others[i] === null
      ? soprano.map(note).join("")
      : `<note><pitch><step>${others[i]![0]}</step><octave>${others[i]![1]}</octave></pitch><duration>12</duration><voice>1</voice><type>half</type></note>`;
    return `<part id="P${i + 1}"><measure number="1"><attributes><divisions>6</divisions><time><beats>2</beats><beat-type>4</beat-type></time><clef>${clef}</clef></attributes>${notes}</measure></part>`;
  });
  const list = clefs.map((_, i) => `<score-part id="P${i + 1}"><part-name>S${i + 1}</part-name></score-part>`).join("");
  return parse(`<score-partwise version="3.1"><part-list>${list}</part-list>${parts.join("")}</score-partwise>`);
}

describe("Triolen", () => {
  it("nimmt eine falsche Triole zurück", () => {
    // zwei Viertel als Triole gelesen (z. B. „cresc.“ für eine 3 gehalten): Takt zu kurz
    const { voices, flags } = splitScore(triplets([["C5", true], ["D5", true]]));
    expect(pitches(voices.get("Sopran"))).toEqual([[72, 1], [74, 1]]);
    expect(flags.some((f) => f.reason.includes("Triole entfernt"))).toBe(true);
  });

  it("lässt eine echte Triole stehen", () => {
    const { voices, flags } = splitScore(triplets([["C5", true], ["D5", true], ["E5", true]]));
    expect(voices.get("Sopran")?.map((e) => Math.round(e.duration * 1000) / 1000)).toEqual([0.667, 0.667, 0.667]);
    expect(flags.some((f) => f.reason.includes("Triole"))).toBe(false);
  });
});

describe("Klavierauszug", () => {
  it("übergeht das Klavier", () => {
    const half = (step: string, octave: number, staff = "") =>
      `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>12</duration><voice>1</voice><type>half</type>${staff}</note>`;
    const part = (id: string, clefs: string, notes: string, staves = "") =>
      `<part id="${id}"><measure number="1"><attributes><divisions>6</divisions><time><beats>2</beats><beat-type>4</beat-type></time>${staves}${clefs}</attributes>${notes}</measure></part>`;
    const choir: [string, string, string][] = [
      ["<sign>G</sign><line>2</line>", "E", "5"], ["<sign>G</sign><line>2</line>", "C", "5"],
      ["<sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change>", "G", "4"], ["<sign>F</sign><line>4</line>", "C", "3"],
    ];
    const parts = choir.map(([clef, step, oct], i) => part(`P${i + 1}`, `<clef>${clef}</clef>`, half(step, Number(oct))));
    parts.push(part("P5", '<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>',
      half("A", 5, "<staff>1</staff>") + "<backup><duration>12</duration></backup>" + half("A", 1, "<staff>2</staff>"), "<staves>2</staves>"));
    const list = [...choir.map((_, i) => `<score-part id="P${i + 1}"><part-name>Voice</part-name></score-part>`), '<score-part id="P5"><part-name>Piano</part-name></score-part>'].join("");
    const s = parse(`<score-partwise version="3.1"><part-list>${list}</part-list>${parts.join("")}</score-partwise>`);
    expect(detectLayout(s)).toBe("SATB-offen");
    const { voices } = splitScore(s);
    expect([...voices.keys()].sort()).toEqual(["Alt", "Bass", "Sopran", "Tenor"]);
    expect(voices.get("Bass")?.map((e) => e.midi)).toEqual([48]);
  });
});

describe("benannte Stimmen", () => {
  it("übernimmt die Stimmnamen aus der Datei", () => {
    const s = score([
      { name: "Tenor I", clef: ["G", 2, -1], measures: [[[["E3", 2]]]] },
      { name: "Tenor II", clef: ["G", 2, -1], measures: [[[["C3", 2]]]] },
    ]);
    const { layout, voices } = splitScore(s);
    expect(layout).toBe("benannt");
    expect([...voices.keys()]).toEqual(["Tenor I", "Tenor II"]);
  });
});
