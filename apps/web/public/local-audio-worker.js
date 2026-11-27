/* global importScripts, createFFmpegCore */
const coreURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js";
const wasmURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm";

function textAt(view, offset) {
  return String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, 4));
}

function waveformFromWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 44 || textAt(view, 0) !== "RIFF" || textAt(view, 8) !== "WAVE") {
    throw new Error("음원 파형을 읽을 수 없습니다.");
  }

  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = 0;
  let dataSize = 0;

  for (let pos = 12; pos + 8 <= view.byteLength;) {
    const type = textAt(view, pos);
    const size = view.getUint32(pos + 4, true);
    const offset = pos + 8;

    if (size > view.byteLength - offset) throw new Error("음원 파형 데이터가 온전하지 않습니다.");
    if (type === "fmt " && size >= 16) {
      channels = view.getUint16(offset + 2, true);
      sampleRate = view.getUint32(offset + 4, true);
      bits = view.getUint16(offset + 14, true);
    }
    if (type === "data") {
      dataOffset = offset;
      dataSize = size;
      break;
    }

    pos = offset + size + (size % 2);
  }

  if (!sampleRate || bits !== 16 || channels < 1 || channels > 2 || !dataSize) {
    throw new Error("모노 또는 스테레오 음원만 지원합니다.");
  }

  const frames = Math.floor(dataSize / (channels * 2));
  if (!frames) throw new Error("음원이 비어 있습니다.");

  const count = Math.min(1600, frames);
  const peaks = Array.from({ length: channels }, () => Array(count).fill(0));

  for (let frame = 0; frame < frames; frame++) {
    const bucket = Math.min(count - 1, Math.floor(frame * count / frames));
    for (let channel = 0; channel < channels; channel++) {
      const sample = view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 32768;
      if (Math.abs(sample) > Math.abs(peaks[channel][bucket])) peaks[channel][bucket] = sample;
    }
  }

  return { duration: Math.round(frames * 1000 / sampleRate), peaks, channels };
}

function progress(message) {
  self.postMessage({ type: "progress", message });
}

self.onmessage = async ({ data }) => {
  try {
    const { file, maxDurationSeconds } = data;
    progress("FFmpeg 음원 처리기를 불러오는 중…");
    importScripts(coreURL);

    const ffmpeg = await createFFmpegCore({
      mainScriptUrlOrBlob: coreURL + "#" + btoa(JSON.stringify({ wasmURL, workerURL: "" })),
    });

    ffmpeg.FS.writeFile("input", new Uint8Array(await file.arrayBuffer()));
    const run = (args) => {
      ffmpeg.setTimeout(120_000);
      ffmpeg.exec(...args);
      const code = ffmpeg.ret;
      ffmpeg.reset();
      if (code !== 0) throw new Error("지원하지 않거나 손상된 음원입니다. 다시 선택해 주세요.");
    };

    progress("채널별 파형을 생성하는 중…");
    run(["-i", "input", "-map", "0:a:0", "-t", String(maxDurationSeconds + 1), "-ar", "8000", "-c:a", "pcm_s16le", "-y", "shape.wav"]);
    const { duration, peaks, channels } = waveformFromWav(ffmpeg.FS.readFile("shape.wav"));

    if (duration > maxDurationSeconds * 1000) {
      throw new Error("브라우저 버전은 최대 10분 길이의 음원을 지원합니다.");
    }

    progress("재생용 음원을 만드는 중…");
    run(["-i", "input", "-map", "0:a:0", "-ac", String(channels), "-ar", "44100", "-c:a", "libmp3lame", "-q:a", "2", "-y", "preview.mp3"]);
    const previewBytes = ffmpeg.FS.readFile("preview.mp3");
    if (!previewBytes.length) throw new Error("재생용 음원을 만들지 못했습니다.");

    const preview = previewBytes.buffer.slice(previewBytes.byteOffset, previewBytes.byteOffset + previewBytes.byteLength);
    self.postMessage({ type: "result", preview, duration, peaks }, [preview]);
  } catch (cause) {
    self.postMessage({ type: "error", message: cause instanceof Error ? cause.message : "음원을 처리하지 못했습니다." });
  }
};
