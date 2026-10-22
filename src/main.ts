// Oberfläche: Datei öffnen, Erkanntes zeigen, Übedateien erzeugen, herunterladen.

import { zipSync } from "fflate";
import mp3WasmUrl from "wasm-media-encoders/wasm/mp3?url";
import soundFontUrl from "./assets/chor.sf3?url";
import { expand, playOrder } from "./form.ts";
import { timeline, type Mode } from "./midi.ts";
import type { Flag } from "./model.ts";
import { analyze, cleanTitle, defaultVoice, LAYOUT_LABELS, planFiles, UnsupportedScore, type Analysis, type PlannedFile } from "./practice.ts";
import "./style.css";

declare const __APP_VERSION__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`chor.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`chor.${key}`, value);
    } catch {
      // ohne Speicher geht es auch
    }
  },
};

let analysis: Analysis | null = null;
/** Länge eines Durchlaufs in Vierteln, Wiederholungen ausgeschrieben */
let pieceQuarters = 0;
let results: { name: string; blob: Blob; url: string }[] = [];
/** Titel, mit dem das letzte Paket erzeugt wurde (Ordnername in der ZIP-Datei) */
let packageTitle = "Stück";
/** zählt geöffnete Dateien, damit ein laufendes Erzeugen nach einem Dateiwechsel abbricht */
let generation = 0;

// ---------- Hintergrund-Rechner ----------

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: { mp3: Uint8Array; seconds: number }) => void; reject: (e: Error) => void; progress: (p: number) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./render/worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    const job = pending.get(msg.id);
    if (!job) return;
    if (msg.type === "progress") job.progress(msg.part);
    else if (msg.type === "done") {
      pending.delete(msg.id);
      job.resolve({ mp3: msg.mp3, seconds: msg.seconds });
    } else if (msg.type === "error") {
      pending.delete(msg.id);
      job.reject(new Error(msg.message));
    }
  };
  worker.onerror = () => {
    for (const job of pending.values()) job.reject(new Error("Der Hintergrund-Rechner ist abgestürzt."));
    pending.clear();
    worker = null;
  };
  worker.postMessage({
    type: "init",
    soundfont: new URL(soundFontUrl, location.href).href,
    mp3wasm: new URL(mp3WasmUrl, location.href).href,
  });
  return worker;
}

function renderMp3(midi: Uint8Array, progress: (p: number) => void): Promise<{ mp3: Uint8Array; seconds: number }> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, progress });
    getWorker().postMessage({ type: "render", id, midi });
  });
}

// ---------- Schritt 1: Datei ----------

const fileInput = $<HTMLInputElement>("file");
const drop = $<HTMLLabelElement>("drop");

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
});

for (const name of ["dragenter", "dragover"]) {
  drop.addEventListener(name, (ev) => {
    ev.preventDefault();
    drop.classList.add("over");
  });
}
for (const name of ["dragleave", "drop"]) {
  drop.addEventListener(name, () => drop.classList.remove("over"));
}
drop.addEventListener("drop", (ev) => {
  ev.preventDefault();
  const file = (ev as DragEvent).dataTransfer?.files?.[0];
  if (file) void openFile(file);
});
// eine daneben fallengelassene Datei soll nicht die Seite ersetzen
window.addEventListener("dragover", (ev) => ev.preventDefault());
window.addEventListener("drop", (ev) => ev.preventDefault());

function show(id: string, visible: boolean): void {
  $(id).hidden = !visible;
}

function message(id: string, text: string | null): void {
  const el = $(id);
  el.textContent = text ?? "";
  el.hidden = !text;
}

async function openFile(file: File): Promise<void> {
  generation += 1;
  message("file-error", null);
  clearResults();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    analysis = analyze(bytes, new DOMParser(), file.name);
  } catch (err) {
    analysis = null;
    show("step-check", false);
    show("step-make", false);
    const text = err instanceof UnsupportedScore ? err.message : `Die Datei ließ sich nicht lesen: ${(err as Error).message}`;
    message("file-error", text);
    return;
  }
  pieceQuarters = timeline(expand(analysis.voices, playOrder(analysis.form))).total;
  showAnalysis(analysis);
  setupOptions(analysis);
  show("step-check", true);
  show("step-make", true);
  updatePlan();
  getWorker(); // lädt den Klang schon im Voraus
}

// ---------- Schritt 2: Erkannt ----------

const VOICE_LABELS: Record<string, string> = {
  alle: "alle Stimmen",
  beide: "beide Stimmen des Systems",
  oben: "obere Stimme des Systems",
  unten: "untere Stimme des Systems",
};

function showAnalysis(a: Analysis): void {
  $<HTMLInputElement>("title").value = a.title;
  let layout = LAYOUT_LABELS[a.layout] ?? a.layout;
  if (a.skippedStaffs) layout += `. Die Klavierbegleitung wird übergangen.`;
  $("fact-layout").textContent = layout;
  $("fact-voices").textContent = [...a.voices]
    .map(([name, events]) => `${name} (${events.filter((e) => e.midi !== null).length} Noten)`)
    .join(", ");
  const parts = [`${a.measures} Takte`, `${a.ts.numerator}/${a.ts.denominator}-Takt`];
  if (a.repeats) parts.push("Wiederholungen werden ausgeschrieben");
  $("fact-size").textContent = parts.join(" · ");

  const divided = [...a.voices.keys()].filter((name) => / 2$/.test(name) && a.voices.has(name.slice(0, -2)));
  const box = $("flags");
  box.replaceChildren();
  for (const name of divided) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = `${name} ist die untere Stimme dort, wo sich der ${name.slice(0, -2)} teilt; sonst singt sie mit.`;
    box.append(p);
  }
  const byMeasure = (x: Flag, y: Flag) => x.measure - y.measure;
  const fixed = a.flags.filter((f) => AUTOMATIC.some((r) => f.reason.startsWith(r))).sort(byMeasure);
  const open = a.flags.filter((f) => !AUTOMATIC.some((r) => f.reason.startsWith(r))).sort(byMeasure);
  if (a.voltas) {
    open.unshift({ measure: -1, number: "", voice: "", reason: "Das Stück hat 1./2.-Klammern. Die spielt die App noch nicht richtig ab." });
  }
  if (open.length === 0) {
    const ok = document.createElement("p");
    ok.className = "ok";
    ok.textContent = "Die Prüfung hat nichts Auffälliges gefunden.";
    box.append(ok);
  } else {
    box.append(
      flagBox(
        open.length === 1 ? "Eine Stelle bitte im Notenbild nachsehen" : `${open.length} Stellen bitte im Notenbild nachsehen`,
        "Hier hat die Erkennung vielleicht falsch gelesen. Korrigieren geht in einer späteren Version; bis dahin klingen diese Stellen so, wie sie erkannt wurden.",
        open,
        "",
      ),
    );
  }
  if (fixed.length) {
    box.append(flagBox("Automatisch berichtigt", "Diese Lesefehler hat die App selbst behoben.", fixed, "info"));
  }
}

/** Hinweise, bei denen die App den Fehler schon selbst behoben hat */
const AUTOMATIC = ["Triole entfernt", "Violinschlüssel ohne 8"];

function flagBox(title: string, intro: string, flags: Flag[], extraClass: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = extraClass ? `flags ${extraClass}` : "flags";
  const h = document.createElement("h3");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = intro;
  const ul = document.createElement("ul");
  const limit = 40;
  for (const f of flags.slice(0, limit)) {
    const li = document.createElement("li");
    li.textContent = flagText(f);
    ul.append(li);
  }
  if (flags.length > limit) {
    const li = document.createElement("li");
    li.textContent = `und ${flags.length - limit} weitere`;
    ul.append(li);
  }
  wrap.append(h, p, ul);
  return wrap;
}

function flagText(f: Flag): string {
  if (f.measure < 0) return f.reason;
  const who = VOICE_LABELS[f.voice] ?? f.voice;
  return `Takt ${f.number}, ${who}: ${f.reason}`;
}

// ---------- Schritt 3: Einstellungen ----------

const roleInputs = () => [...document.querySelectorAll<HTMLInputElement>('input[name="role"]')];
const variantInputs = () => [...document.querySelectorAll<HTMLInputElement>('input[name="variant"]')];
const percentInputs = () => [...document.querySelectorAll<HTMLInputElement>('input[name="percent"]')];
const voiceSelect = $<HTMLSelectElement>("voice");
const tempoInput = $<HTMLInputElement>("tempo");
const passesInput = $<HTMLInputElement>("passes");
const midiInput = $<HTMLInputElement>("with-midi");

const ROLE_VARIANTS: Record<string, Mode[]> = { singer: ["solo", "mix"], conductor: ["mix", "gesamt"] };

function role(): string {
  return roleInputs().find((r) => r.checked)?.value ?? "singer";
}

function applyRole(): void {
  const variants = ROLE_VARIANTS[role()];
  for (const v of variantInputs()) v.checked = variants.includes(v.value as Mode);
  $("voice-field").hidden = role() !== "singer";
}

function setupOptions(a: Analysis): void {
  const names = [...a.voices.keys()];
  voiceSelect.replaceChildren(...names.map((n) => new Option(n, n)));
  voiceSelect.value = defaultVoice(names, store.get("voice"));
  tempoInput.value = String(a.tempo ? Math.round(a.tempo) : 80);
  const savedRole = store.get("role");
  for (const r of roleInputs()) r.checked = r.value === (savedRole === "conductor" ? "conductor" : "singer");
  const savedPercents = store.get("percents");
  if (savedPercents) {
    const list = savedPercents.split(",");
    for (const p of percentInputs()) p.checked = list.includes(p.value);
  }
  midiInput.checked = store.get("midi") === "1";
  passesInput.value = "1";
  applyRole();
}

function options() {
  const a = analysis as Analysis;
  const variants = variantInputs().filter((v) => v.checked).map((v) => v.value as Mode);
  const percents = percentInputs().filter((p) => p.checked).map((p) => Number(p.value));
  const targets = role() === "singer" ? [voiceSelect.value] : [...a.voices.keys()];
  return {
    title: $<HTMLInputElement>("title").value,
    targets,
    variants,
    percents,
    tempo: Math.min(240, Math.max(20, Number(tempoInput.value) || 80)),
    passes: Math.min(12, Math.max(1, Math.round(Number(passesInput.value) || 1))),
    midi: midiInput.checked,
  };
}

function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function updatePlan(): void {
  if (!analysis) return;
  const o = options();
  const button = $<HTMLButtonElement>("make");
  const mp3s = o.variants.filter((v) => v !== "gesamt").length * o.targets.length + (o.variants.includes("gesamt") ? 1 : 0);
  if (mp3s === 0 || o.percents.length === 0) {
    $("plan").textContent = "Bitte mindestens eine Fassung und ein Übetempo wählen.";
    button.disabled = true;
    return;
  }
  button.disabled = false;
  const count = mp3s * o.percents.length;
  const length = ((pieceQuarters * 60) / o.tempo) * o.passes;
  const extra = o.midi ? ` und ${mp3s} MIDI-Dateien` : "";
  $("plan").textContent = `${count} MP3-Dateien${extra}. Länge bei 100 %: ${minutes(length)} Minuten.`;
}

for (const r of roleInputs()) {
  r.addEventListener("change", () => {
    store.set("role", role());
    applyRole();
    updatePlan();
  });
}
voiceSelect.addEventListener("change", () => {
  store.set("voice", voiceSelect.value);
  updatePlan();
});
for (const p of percentInputs()) {
  p.addEventListener("change", () => {
    store.set("percents", percentInputs().filter((x) => x.checked).map((x) => x.value).join(","));
    updatePlan();
  });
}
midiInput.addEventListener("change", () => {
  store.set("midi", midiInput.checked ? "1" : "0");
  updatePlan();
});
for (const el of [...variantInputs(), tempoInput, passesInput]) el.addEventListener("input", updatePlan);

// ---------- Erzeugen ----------

$("make").addEventListener("click", () => void make());

async function make(): Promise<void> {
  if (!analysis) return;
  const mine = generation;
  const button = $<HTMLButtonElement>("make");
  button.disabled = true;
  message("make-error", null);
  clearResults();
  const o = options();
  packageTitle = cleanTitle(o.title) || "Stück";
  let files: PlannedFile[];
  try {
    files = planFiles(analysis, o);
  } catch (err) {
    message("make-error", `Das ging schief: ${(err as Error).message}`);
    button.disabled = false;
    return;
  }
  const mp3s = files.filter((f) => f.kind === "mp3");
  show("progress", true);
  const bar = $<HTMLProgressElement>("progress-bar");
  const text = $("progress-text");
  const started = performance.now();
  try {
    for (const f of files.filter((x) => x.kind === "mid")) addResult(f.name, f.midi);
    for (let k = 0; k < mp3s.length; k++) {
      const f = mp3s[k];
      const label = `Datei ${k + 1} von ${mp3s.length}: ${f.label} – ${f.percent} %`;
      text.textContent = label + remaining(started, k, mp3s.length);
      const { mp3 } = await renderMp3(f.midi, (part) => {
        bar.value = (k + part) / mp3s.length;
      });
      if (mine !== generation) return; // inzwischen wurde eine andere Datei geöffnet
      bar.value = (k + 1) / mp3s.length;
      addResult(f.name, mp3);
    }
    text.textContent = `Fertig: ${mp3s.length} MP3-Dateien in ${minutes((performance.now() - started) / 1000)} Minuten.`;
    show("step-done", true);
    $("step-done").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    message("make-error", `Das ging schief: ${(err as Error).message}`);
  } finally {
    button.disabled = false;
  }
}

function remaining(started: number, done: number, total: number): string {
  if (done === 0) return "";
  const per = (performance.now() - started) / 1000 / done;
  const left = per * (total - done);
  return left > 20 ? ` · noch etwa ${Math.max(1, Math.round(left / 60))} Min.` : "";
}

// ---------- Schritt 4: Ergebnis ----------

function clearResults(): void {
  for (const r of results) URL.revokeObjectURL(r.url);
  results = [];
  $("results").replaceChildren();
  show("step-done", false);
  show("progress", false);
  $<HTMLProgressElement>("progress-bar").value = 0;
}

function mimeOf(name: string): string {
  return name.endsWith(".mp3") ? "audio/mpeg" : "audio/midi";
}

function addResult(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as BlobPart], { type: mimeOf(name) });
  const url = URL.createObjectURL(blob);
  results.push({ name, blob, url });
  const li = document.createElement("li");
  const title = document.createElement("div");
  title.className = "name";
  title.textContent = name;
  li.append(title);
  const row = document.createElement("div");
  row.className = "row";
  if (name.endsWith(".mp3")) {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = url;
    row.append(audio);
  }
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.textContent = "Laden";
  link.setAttribute("aria-label", `${name} laden`);
  row.append(link);
  li.append(row);
  $("results").append(li);
}

async function zipBlob(): Promise<{ blob: Blob; name: string }> {
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const r of results) entries[`${packageTitle}/${r.name}`] = [new Uint8Array(await r.blob.arrayBuffer()), { level: 0 }];
  const zipped = zipSync(entries);
  return { blob: new Blob([zipped as BlobPart], { type: "application/zip" }), name: `${packageTitle}.zip` };
}

$("zip").addEventListener("click", async () => {
  const { blob, name } = await zipBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

const shareButton = $<HTMLButtonElement>("share");
const probe = typeof File !== "undefined" ? new File([new Uint8Array(1)], "probe.zip", { type: "application/zip" }) : null;
shareButton.hidden = !(probe && typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] }));
shareButton.addEventListener("click", async () => {
  const { blob, name } = await zipBlob();
  const file = new File([blob], name, { type: "application/zip" });
  try {
    await navigator.share({ files: [file], title: name });
  } catch {
    // abgebrochen
  }
});

$("version").textContent = __APP_VERSION__;
