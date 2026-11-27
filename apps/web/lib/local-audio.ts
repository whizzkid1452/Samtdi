const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_DURATION_SECONDS = 600;

export type ProcessedAudio = { preview: Blob; duration: number; peaks: number[][] };

type WorkerResult =
  | { type: "progress"; message: string }
  | { type: "error"; message: string }
  | { type: "result"; preview: ArrayBuffer; duration: number; peaks: number[][] };

export function processLocalAudio(file: File, notify: (message: string) => void): Promise<ProcessedAudio> {
  if (!file.size || file.size > MAX_INPUT_BYTES) {
    return Promise.reject(new Error("100MB 이하의 음원 파일을 선택해 주세요."));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker("/local-audio-worker.js");
    const timeout = window.setTimeout(() => fail(new Error("음원 처리 시간이 초과되었습니다. 더 짧은 음원으로 다시 시도해 주세요.")), 180_000);
    const close = () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };
    const fail = (cause: Error) => {
      close();
      reject(cause);
    };

    worker.onerror = () => fail(new Error("브라우저 음원 처리기를 실행하지 못했습니다."));
    worker.onmessage = ({ data }: MessageEvent<WorkerResult>) => {
      if (data.type === "progress") {
        notify(data.message);
        return;
      }

      if (data.type === "error") {
        fail(new Error(data.message));
        return;
      }

      close();
      resolve({ preview: new Blob([data.preview], { type: "audio/mpeg" }), duration: data.duration, peaks: data.peaks });
    };

    worker.postMessage({ file, maxDurationSeconds: MAX_DURATION_SECONDS });
  });
}
