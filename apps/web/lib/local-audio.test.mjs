import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/local-audio-worker.js", import.meta.url), "utf8");
const context = { self: {}, DataView, Uint8Array, Array, Math, String, Error };
runInNewContext(source, context);

function wav(samples, channels) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (at, value) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, 8000, true);
  view.setUint32(28, 8000 * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + 2 * i, sample, true));
  return new Uint8Array(buffer);
}

test("extracts distinct channel peaks from stereo PCM", () => {
  const shape = context.waveformFromWav(wav([16384, -32768, 0, 8192], 2));
  assert.equal(shape.channels, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(shape.peaks)), [[0.5, 0], [-1, 0.25]]);
});

test("handles mono and rejects missing data or unsupported channels", () => {
  const shape = context.waveformFromWav(wav([32767, -16384], 1));
  assert.equal(shape.channels, 1);
  assert.throws(() => context.waveformFromWav(new Uint8Array(20)));
  assert.throws(() => context.waveformFromWav(wav([0, 0, 0], 3)));
});
