// MP3 aus einer MIDI-Datei mit dem Klang der App, wie im Browser (zum Testen in Node).
// Aufruf: node tools/render-mp3.ts datei.mid ausgabe.mp3
import { readFileSync, writeFileSync } from "node:fs";
import { createMp3Encoder, loadSoundBank, renderMp3 } from "../src/render/audio.ts";

const [midiPath, out] = process.argv.slice(2);
const sf = readFileSync(new URL("../src/assets/chor.sf3", import.meta.url));
const bank = await loadSoundBank(sf.buffer.slice(sf.byteOffset, sf.byteOffset + sf.byteLength));
const encoder = await createMp3Encoder(new Uint8Array(readFileSync(new URL("../node_modules/wasm-media-encoders/wasm/mp3.wasm", import.meta.url))));
const t0 = performance.now();
const { mp3, seconds } = await renderMp3(bank, encoder, new Uint8Array(readFileSync(midiPath)));
writeFileSync(out, mp3);
console.log(`${seconds.toFixed(1)} s Audio in ${((performance.now() - t0) / 1000).toFixed(1)} s, ${(mp3.length / 1e6).toFixed(2)} MB`);
