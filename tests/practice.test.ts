import { describe, expect, it } from "vitest";
import { chooseTitle, defaultVoice, planFiles, titleFromFileName } from "../src/practice.ts";
import { analyze } from "../src/practice.ts";
import { DOMParser } from "@xmldom/xmldom";
import { scoreXml } from "./helpers.ts";

describe("Titel", () => {
  it("kommt aus dem Dateinamen", () => {
    expect(titleFromFileName("035_Der_Herr_mein_Hirte.mxl")).toBe("035 Der Herr mein Hirte");
    expect(titleFromFileName("der-herr-ist-mein-hirt.mxl")).toBe("Der herr ist mein hirt");
    expect(titleFromFileName("045b_Chorus_-_Lass_ihn_kreuzigen.mxl")).toBe("045b Chorus - Lass ihn kreuzigen");
  });

  it("nimmt den erkannten Titel nur, wenn er zum Dateinamen passt", () => {
    expect(chooseTitle("Also hat Gott die Welt geliebt", "also-hat-gott-die-welt-geliebt.mxl")).toBe("Also hat Gott die Welt geliebt");
    expect(chooseTitle("35 Der Hﬂl'l', mein Hirte", "035_Der_Herr_mein_Hirte.mxl")).toBe("035 Der Herr mein Hirte");
    expect(chooseTitle("", "")).toBe("Stück");
  });
});

describe("eigene Stimme", () => {
  it("schlägt im Doppelchor Tenor II vor, sonst Tenor", () => {
    expect(defaultVoice(["Sopran I", "Tenor I", "Sopran II", "Tenor II"], null)).toBe("Tenor II");
    expect(defaultVoice(["Sopran", "Alt", "Tenor", "Bass"], null)).toBe("Tenor");
    expect(defaultVoice(["Sopran", "Alt", "Tenor", "Bass"], "Bass")).toBe("Bass");
    expect(defaultVoice(["Sopran", "Alt"], "Bass")).toBe("Sopran");
  });
});

describe("Paket", () => {
  const xml = scoreXml([
    { measures: [[[["G4", 1, "up"], ["A4", 1, "up"]], [["E4", 1, "down"], ["F4", 1, "down"]]]] },
    { clef: ["F", 4], measures: [[[["C4", 1, "up"], ["C4", 1, "up"]], [["C3", 1, "down"], ["F3", 1, "down"]]]] },
  ]);
  const analysis = analyze(new TextEncoder().encode(xml), new DOMParser() as never, "probe.musicxml");

  it("erkennt den geschlossenen Satz", () => {
    expect(analysis.layout).toBe("SATB");
    expect([...analysis.voices.keys()]).toEqual(["Sopran", "Alt", "Tenor", "Bass"]);
    expect(analysis.title).toBe("Probe");
  });

  it("plant Dateien für Sänger und Chorleiter", () => {
    const singer = planFiles(analysis, { title: "Probe", targets: ["Tenor"], variants: ["solo", "mix"], percents: [100, 85], tempo: 80, passes: 1, midi: true });
    expect(singer.map((f) => f.name)).toEqual([
      "Probe – Tenor – Solo.mid",
      "Probe – Tenor – Solo – 100 %.mp3",
      "Probe – Tenor – Solo – 85 %.mp3",
      "Probe – Tenor – Übe-Mix.mid",
      "Probe – Tenor – Übe-Mix – 100 %.mp3",
      "Probe – Tenor – Übe-Mix – 85 %.mp3",
    ]);
    const choir = planFiles(analysis, { title: "Pro/be", targets: ["Sopran", "Alt", "Tenor", "Bass"], variants: ["mix", "gesamt"], percents: [100], tempo: 80, passes: 2, midi: false });
    expect(choir.map((f) => f.name)).toEqual([
      "Pro be – Sopran – Übe-Mix – 100 %.mp3",
      "Pro be – Alt – Übe-Mix – 100 %.mp3",
      "Pro be – Tenor – Übe-Mix – 100 %.mp3",
      "Pro be – Bass – Übe-Mix – 100 %.mp3",
      "Pro be – Gesamt – 100 %.mp3",
    ]);
  });
});
