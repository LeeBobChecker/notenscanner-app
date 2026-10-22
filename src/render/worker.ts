// Hintergrund-Rechner für die MP3s, damit die Seite bedienbar bleibt.
// Nachrichten: {type: "init", soundfont, mp3wasm} lädt Klang und MP3-Encoder (Adressen);
// {type: "render", id, midi} liefert
// {type: "progress", id, part}, dann {type: "done", id, mp3, seconds} oder {type: "error", id, message}.

import type { BasicSoundBank } from "spessasynth_core";
import { createMp3Encoder, loadSoundBank, renderMp3, type Mp3Encoder } from "./audio.ts";

let ready: Promise<[BasicSoundBank, Mp3Encoder]> | null = null;

type Incoming = { type: "init"; soundfont: string; mp3wasm: string } | { type: "render"; id: number; midi: Uint8Array };

async function download(url: string, what: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${what} nicht geladen (${r.status})`);
  return r.arrayBuffer();
}

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent<Incoming>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    ready = Promise.all([
      download(msg.soundfont, "Klang").then(loadSoundBank),
      download(msg.mp3wasm, "MP3-Baustein").then(createMp3Encoder),
    ]);
    return;
  }
  try {
    if (!ready) throw new Error("Klang nicht geladen");
    const [bank, encoder] = await ready;
    const { mp3, seconds } = await renderMp3(bank, encoder, msg.midi, (part) => post({ type: "progress", id: msg.id, part }));
    post({ type: "done", id: msg.id, mp3, seconds }, [mp3.buffer]);
  } catch (err) {
    post({ type: "error", id: msg.id, message: (err as Error).message ?? String(err) });
  }
};
