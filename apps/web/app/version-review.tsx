"use client";

import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../lib/api";
import { VersionNotes } from "./version-notes";
import type { MediaVersion } from "./media-library";

export function timecode(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${String(Math.round(ms) % 1000).padStart(3, "0")}`;
}

export function VersionReview({ base, version, initialAt, initialNote, projectId, accountId, canEdit, writable }: {
  base: string; version: MediaVersion; initialAt?: number; initialNote?: string;
  projectId: string; accountId: string; canEdit: boolean; writable: boolean;
}) {
  const path = base + "/versions/" + version.id;
  const duration = version.duration_ms ?? 0;
  const audio = useRef<HTMLAudioElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [position, setPosition] = useState(0);
  const [start, setStart] = useState<number>();
  const [end, setEnd] = useState<number>();
  const [error, setError] = useState("");

  useEffect(() => {
    const request = new AbortController();
    api<{ peaks: number[] }>(path + "/files/peaks", { signal: request.signal }).then((data) => {
      if (!request.signal.aborted) setPeaks(data.peaks);
    }).catch((cause) => {
      if (!request.signal.aborted) setError(describeError(cause));
    });
    return () => request.abort();
  }, [path]);

  useEffect(() => {
    const target = canvas.current;
    const context = target?.getContext("2d");
    if (!target || !context || !duration) return;
    const width = target.width;
    const height = target.height;
    context.clearRect(0, 0, width, height);
    if (start !== undefined && end !== undefined && end > start) {
      context.fillStyle = "#3d4b2e";
      context.fillRect(start / duration * width, 0, (end - start) / duration * width, height);
    }

    const barWidth = width / (peaks.length || 1);
    for (const [index, value] of peaks.entries()) {
      const barHeight = Math.max(2, Math.min(1, value) * height);
      context.fillStyle = index / peaks.length <= position / duration ? "#d3ed8a" : "#8a95af";
      context.fillRect(index * barWidth, (height - barHeight) / 2, Math.max(1, barWidth - 1), barHeight);
    }
    context.fillStyle = "#f3f1ed";
    context.fillRect(position / duration * width, 0, 2, height);
  }, [duration, end, peaks, position, start]);

  function seek(target: number) {
    if (!Number.isFinite(target) || !audio.current) return;
    const next = Math.round(Math.min(duration, Math.max(0, target)));
    audio.current.currentTime = next / 1000;
    setPosition(next);
  }

  return (
    <div className="version-review">
      <audio ref={audio} aria-label="버전 재생" controls preload="metadata" src={path + "/files/playback"}
        onLoadedMetadata={() => { if (initialAt !== undefined) seek(initialAt); }}
        onTimeUpdate={(event) => setPosition(Math.round(event.currentTarget.currentTime * 1000))}
        onError={() => setError("재생 파일에 접근하지 못했습니다. 연결과 프로젝트 권한을 확인해 주세요.")} />
      {error && <p role="alert" className="error">{error}</p>}
      <canvas ref={canvas} width={1024} height={144} className="waveform" aria-hidden="true" onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        seek((event.clientX - bounds.left) / bounds.width * duration);
      }} />
      <label className="seek"><span>{timecode(position)} / {timecode(duration)}</span>
        <input aria-label="재생 위치" type="range" min={0} max={duration} step={1} value={Math.min(position, duration)}
          onChange={(event) => seek(Number(event.target.value))} />
      </label>
      <div className="row wrap">
        <button onClick={() => setStart(position)}>구간 시작 지정</button>
        <button onClick={() => setEnd(position)}>구간 끝 지정</button>
        {start !== undefined && <span>{timecode(start)}{end !== undefined ? " ~ " + timecode(end) : ""}</span>}
        <a className="button" href={path + "/files/original"}>원본 다운로드</a>
      </div>
      <VersionNotes path={path} projectId={projectId} versionId={version.id} accountId={accountId} initialNote={initialNote}
        canEdit={canEdit} writable={writable} position={position} start={start} end={end} seek={seek} />
    </div>
  );
}
