# Chor-Übedateien

Eine Web-App, die aus der MusicXML-Datei von [Audiveris](https://github.com/Audiveris/audiveris)
Übedateien für Chorstimmen macht: Solo, Übe-Mix und Gesamtfassung als MP3, auf
Wunsch auch als MIDI, in mehreren Übetempi.

**Datenschutz:** Die App läuft komplett im Browser. Noten und Übedateien
verlassen das Gerät nicht. Dieses Repository enthält nur Programmcode, keine Noten.

## Benutzen

1. Noten mit 300 bis 400 dpi scannen und in Audiveris öffnen,
   *Book › Transcribe book*, dann *Book › Export book*. Es entsteht eine `.mxl`-Datei.
2. Die App öffnen und die Datei wählen (am Mac auch hineinziehen).
3. Wählen: „Meine Stimme üben“ (Solo und Übe-Mix) oder „Für den Chor“
   (Übe-Mix jeder Stimme und Gesamtfassung). Tempo einstellen.
4. „Übedateien erzeugen“, anhören, einzeln laden oder alle als ZIP.

## Was die App kann

- Geschlossener Satz (Sopran und Alt oben, Tenor und Bass unten), offene
  Partitur, Klavierauszug (das Klavier wird übergangen), Stimmen mit Namen
- Geteilte Stimmen (Divisi) als eigene Stimme, etwa „Bass 2“
- Tenor im Violinschlüssel ohne kleine 8 wird eine Oktave tiefer gesetzt
- Prüfung: markiert Takte, die die Erkennung vielleicht falsch gelesen hat
- Wiederholungen werden ausgeschrieben, mehrere Durchläufe für Strophen
- Gleichmäßiges Tempo ohne Vorspann; Fermaten und Ritardandi werden ignoriert

Noch nicht: Korrigieren in der App, 1./2.-Klammern, acht Stimmen im
geschlossenen Satz.

## Entwicklung

```bash
npm ci          # Abhängigkeiten (ohne Installationsskripte, siehe .npmrc)
npm test        # Tests
npm run dev     # lokal ausprobieren
npm run build   # fertige Seite in dist/
```

Die Logik stammt aus einem Python-Prototyp. Beim Übertragen wurden beide an
64 Erkennungsdateien verglichen: gleiche Stimmen, gleiche Hinweise, gleiche
Korrekturen und Byte für Byte gleiche MIDI-Dateien. Werkzeuge dafür in `tools/`:

| Datei | Zweck |
|---|---|
| `dump-score.ts` | wie die App eine MusicXML-Datei liest (JSON) |
| `dump-voices.ts` | getrennte Stimmen, Hinweise, Korrekturen (JSON) |
| `practice-midi.ts` | MIDI-Übedateien wie der Prototyp |
| `render-mp3.ts` | MP3 aus einer MIDI-Datei mit dem Klang der App |
| `build-soundfont.mjs` | baut `src/assets/chor.sf3` (Klavier und Streicher aus FluidR3) |

Lizenzen der verwendeten Bausteine: [public/lizenzen.txt](public/lizenzen.txt).
