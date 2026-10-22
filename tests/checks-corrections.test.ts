import { describe, expect, it } from "vitest";
import { check, formatG } from "../src/checks.ts";
import { applyCorrections, dropChecked, parseNotes } from "../src/corrections.ts";
import { expand, playOrder, type Mark } from "../src/form.ts";
import type { NoteEvent, Voices } from "../src/model.ts";
import { voice } from "./helpers.ts";

const text = (events: NoteEvent[] | undefined, measure: number) =>
  (events ?? []).filter((e) => e.measure === measure).map((e) => [e.midi, e.duration, e.tie]);
const voices = (entries: Record<string, NoteEvent[]>): Voices => new Map(Object.entries(entries));

describe("Notenschreibweise", () => {
  it("liest Tonhöhe, Notenwert, Punkt und Bogen", () => {
    expect(parseNotes("C#4/4 E4/2. R/8 B#3/4~ Bb3/16")).toEqual([
      [61, 1, null],
      [64, 3, null],
      [null, 0.5, null],
      [60, 1, "start"],
      [58, 0.25, null],
    ]);
    expect(() => parseNotes("H4/4")).toThrow();
  });
});

describe("Korrekturliste", () => {
  it("teilt einen Takt in allen Stimmen, mit Haltebogen über die Grenze", () => {
    const v = voices({ Tenor: voice("C4/2 E4/2 G4/2 C4/2"), Bass: voice("C3/2 G2/1 C3/2") });
    const out = applyCorrections(v, [{ aktion: "takt_teilen", takt: 1, nach: 4 }]).voices;
    expect(text(out.get("Tenor"), 0)).toEqual([[60, 2, null], [64, 2, null]]);
    expect(text(out.get("Tenor"), 1)).toEqual([[67, 2, null], [60, 2, null]]);
    expect(text(out.get("Bass"), 0)).toEqual([[48, 2, null], [43, 2, "start"]]);
    expect(text(out.get("Bass"), 1)).toEqual([[43, 2, "stop"], [48, 2, null]]);
    expect(out.get("Bass")?.map((e) => e.number)).toEqual(["1", "1", "2", "2"]);
  });

  it("schließt beim Ersetzen einen offenen Haltebogen", () => {
    const v = voices({ Tenor: voice("C#4/2 C#4/2~", "D4/1") });
    const out = applyCorrections(v, [{ aktion: "takt_ersetzen", stimme: "Tenor", takt: 2, noten: "C#4/4 F#4/4 E4/2" }]).voices;
    expect(text(out.get("Tenor"), 1)).toEqual([[61, 1, "stop"], [66, 1, null], [64, 2, null]]);
  });

  it("zählt die Takte ab einer gewählten Nummer", () => {
    const v = voices({ Tenor: voice("R/2", "E4/1", "F4/1") });
    const out = applyCorrections(v, [
      { aktion: "taktnummern", erster: 35 },
      { aktion: "takt_ersetzen", stimme: "Tenor", takt: 37, noten: "G4/1" },
    ]).voices;
    expect(out.get("Tenor")?.map((e) => e.number)).toEqual(["35", "36", "37"]);
    expect(text(out.get("Tenor"), 2)).toEqual([[67, 4, null]]);
  });

  it("fügt einen Takt mit Pausen in den übrigen Stimmen ein und nimmt die Form mit", () => {
    const v = voices({ Sopran: voice("C5/1", "D5/1"), Tenor: voice("C4/1", "D4/1") });
    const form = makeForm(2, null, 1);
    const out = applyCorrections(v, [{ aktion: "takt_einfuegen", takt: 3, noten: { Sopran: "E5/2 F5/2" } }], form);
    expect(text(out.voices.get("Sopran"), 2).map(([m, d]) => [m, d])).toEqual([[76, 2], [77, 2]]);
    expect(text(out.voices.get("Tenor"), 2).map(([m, d]) => [m, d])).toEqual([[null, 4]]);
    expect(out.form?.map((m) => m.end)).toEqual([false, true, false]);
  });

  it("nimmt beim Teilen das Wiederholungszeichen mit", () => {
    const v = voices({ Tenor: voice("C4/2 D4/2 E4/2 F4/2") });
    const out = applyCorrections(v, [{ aktion: "takt_teilen", takt: 1, nach: 4 }], makeForm(1, 0, 0));
    expect(out.form?.map((m) => [m.start, m.end])).toEqual([[true, false], [false, true]]);
  });

  it("setzt eine Wiederholung", () => {
    const v = voices({ Tenor: voice("C4/1", "D4/1", "E4/1") });
    const out = applyCorrections(v, [{ aktion: "wiederholung", von: 1, bis: 2 }], makeForm(3));
    expect(playOrder(out.form as Mark[])).toEqual([0, 1, 0, 1, 2]);
  });
});

describe("Prüfung", () => {
  it("findet falsche Taktlängen", () => {
    const v = voices({
      Sopran: voice("E5/4 E5/4 E5/4 E5/4", "E5/2 E5/2 E5/4", "E5/1"),
      Tenor: voice("C4/4 C4/4 C4/4 C4/4", "C4/2 C4/2 C4/4", "C4/2 C4/4"),
    });
    const reasons = check(v, 4).map((f) => [f.number, f.voice, f.reason]);
    expect(reasons).toContainEqual(["2", "alle", "Takt hat 5 statt 4 Viertel"]);
    expect(reasons).toContainEqual(["3", "Tenor", "Stimme hat 3 statt 4 Viertel"]);
    expect(reasons.some(([n]) => n === "1")).toBe(false);
  });

  it("akzeptiert Auftakt und passenden Schlusstakt", () => {
    expect(check(voices({ Tenor: voice("C4/4", "C4/1", "C4/2.") }), 4)).toEqual([]);
  });

  it("findet einen Takt ohne Noten", () => {
    const v = voices({ Sopran: voice("C5/1", "R/1", "C5/1"), Tenor: voice("C4/1", "R/1", "C4/1") });
    expect(check(v, 4).map((f) => [f.number, f.reason])).toEqual([["2", "Takt ohne Noten, fehlen ganze Noten?"]]);
  });

  it("findet Töne außerhalb des Stimmumfangs und große Sprünge", () => {
    const reasons = check(voices({ Tenor: voice("C4/4 C2/4 C4/2") }), 4).map((f) => f.reason);
    expect(reasons).toContain("Ton außerhalb des Stimmumfangs");
    expect(reasons).toContain("Sprung größer als eine Oktave");
  });

  it("findet eine Stimme, die mitten im Satz einen Takt pausiert", () => {
    const flags = check(voices({ Sopran: voice("C5/2 D5/2", "E5/1", "D5/1"), Alt: voice("A4/2 B4/2", "R/1", "B4/1") }), 4);
    expect(flags.map((f) => [f.number, f.voice])).toEqual([["2", "Alt"]]);
    expect(flags[0].reason).toContain("pausiert");
  });

  it("meldet lange Pausen und das Warten vor einem Einsatz nicht", () => {
    const v = voices({
      Sopran: voice("C5/1", "D5/1", "E5/1", "F5/1", "E5/1"),
      Alt: voice("A4/1", "R/1", "R/1", "R/1", "B4/1"),
      Tenor: voice("R/1", "R/1", "E4/1", "F4/1", "E4/1"),
    });
    expect(check(v, 4)).toEqual([]);
  });

  it("meldet einen stummen Schlusstakt", () => {
    const v = voices({ Sopran: voice("C5/1", "D5/1", "C5/1"), Alt: voice("A4/1", "B4/1", "R/1") });
    expect(check(v, 4).map((f) => [f.number, f.voice])).toEqual([["3", "Alt"]]);
  });

  it("findet einen ganz aus der Nachbarstimme kopierten Takt", () => {
    const alt = voice("A4/1", "B4/1");
    alt[1].source = "unison";
    const flags = check(voices({ Sopran: voice("C5/1", "B4/1"), Alt: alt }), 4);
    expect(flags.map((f) => [f.number, f.voice])).toEqual([["2", "Alt"]]);
    expect(flags[0].reason).toContain("Nachbarstimme");
  });

  it("blendet geprüfte Hinweise aus", () => {
    const v = voices({ Sopran: voice("C5/2 D5/2", "R/1", "D5/1"), Alt: voice("A4/2 B4/2", "B4/1", "B4/1") });
    const steps = [{ aktion: "geprueft", stimme: "Sopran", takt: 2 }];
    expect(applyCorrections(v, steps).voices.get("Sopran")).toEqual(v.get("Sopran"));
    expect(dropChecked(check(v, 4), steps)).toEqual([]);
  });

  it("nimmt einen Auftakt in nur einer Stimme hin", () => {
    expect(check(voices({ Sopran: voice("G4/4", "C5/1", "D5/1"), Alt: voice("R/4", "A4/1", "B4/1") }), 4)).toEqual([]);
  });

  it("schreibt Zahlen wie der Prototyp", () => {
    expect([formatG(5), formatG(4.5), formatG(2 / 3)]).toEqual(["5", "4.5", "0.666667"]);
  });
});

function makeForm(n: number, start: number | null = null, endIdx: number | null = null, times = 2): Mark[] {
  const form = Array.from({ length: n }, () => ({ start: false, end: false, times: 2 }));
  if (start !== null) form[start].start = true;
  if (endIdx !== null) {
    form[endIdx].end = true;
    form[endIdx].times = times;
  }
  return form;
}

describe("Ablauf", () => {
  it("spielt ohne Wiederholung der Reihe nach", () => {
    expect(playOrder(makeForm(4))).toEqual([0, 1, 2, 3]);
  });

  it("wiederholt vom Anfang", () => {
    expect(playOrder(makeForm(5, null, 2))).toEqual([0, 1, 2, 0, 1, 2, 3, 4]);
  });

  it("wiederholt ab einem Startzeichen dreimal", () => {
    expect(playOrder(makeForm(5, 2, 3, 3))).toEqual([0, 1, 2, 3, 2, 3, 2, 3, 4]);
  });

  it("kennt zwei Wiederholungen hintereinander", () => {
    const form = makeForm(4, null, 1);
    form[3].end = true;
    expect(playOrder(form)).toEqual([0, 1, 0, 1, 2, 3, 2, 3]);
  });

  it("reiht Strophen aneinander", () => {
    const out = expand(voices({ Tenor: voice("C4/1", "D4/1") }), [0, 1, 0], 2).get("Tenor") ?? [];
    expect(out.map((e) => e.midi)).toEqual([60, 62, 60, 60, 62, 60]);
    expect(out.map((e) => e.measure)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(out.map((e) => e.number)).toEqual(["1", "2", "1", "1", "2", "1"]);
  });
});
