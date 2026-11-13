"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import { timecode } from "../lib/timecode";
import { ReviewWaveform } from "./review-waveform";
import { FeedbackComposer } from "./feedback-composer";
import { feedbackDraftKey, readFeedbackDraft, useFeedbackDraft, type FeedbackDraft } from "./feedback-drafts";
import { VersionNotes, useVersionNotes } from "./version-notes";
import type { MediaVersion } from "./media-library";

export function VersionReview({ base, version, initialAt, initialNote, projectId, accountId, canEdit, writable }: {
  base: string; version: MediaVersion; initialAt?: number; initialNote?: string;
  projectId: string; accountId: string; canEdit: boolean; writable: boolean;
}) {
  const path = base + "/versions/" + version.id;
  const notesURL = path + "/notes";
  const duration = version.duration_ms ?? 0;
  const key = feedbackDraftKey(accountId, version.id);
  const audio = useRef<HTMLAudioElement>(null);
  const composerTrigger = useRef<HTMLButtonElement>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [metadataReady, setMetadataReady] = useState(false);
  const [volume, setVolume] = useState(1);
  const [range, setRange] = useState<[number, number]>();
  const { draft, updateDraft, storageError } = useFeedbackDraft<FeedbackDraft>({
    key, read: () => readFeedbackDraft({ key, duration }),
  });
  const [editor, setEditor] = useState<"note" | { replyTo: string }>();
  const composerOpen = editor === "note";
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const feedback = useVersionNotes({ url: notesURL, linkedNote: initialNote });
  const validRange = range && range[1] > range[0];
  const linkedPosition = feedback.selected?.id === initialNote ? feedback.selected?.start_ms : undefined;

  useEffect(() => {
    const request = new AbortController();

    api<{ peaks: number[] }>(path + "/files/peaks", { signal: request.signal }).then((data) => {
      if (!request.signal.aborted) setPeaks(data.peaks);
    }).catch((cause) => {
      if (!request.signal.aborted) setError(describeError(cause));
    });
    return () => request.abort();
  }, [path, attempt]);

  useEffect(() => {
    const player = audio.current;
    if (!player || !metadataReady || linkedPosition === undefined) return;
    player.currentTime = linkedPosition / 1000;
  }, [linkedPosition, metadataReady]);

  useEffect(() => {
    const player = audio.current;
    return () => player?.pause();
  }, []);

  function clamp(ms: number) {
    return Math.round(Math.min(duration, Math.max(0, ms)));
  }

  function seek(ms: number) {
    if (!audio.current || !Number.isFinite(ms)) return;
    const next = clamp(ms);
    if (audio.current.currentTime !== next / 1000) audio.current.currentTime = next / 1000;
    setPosition(next);
  }

  function currentPosition() {
    return clamp((audio.current?.currentTime ?? 0) * 1000);
  }

  function compose(useRange: boolean) {
    const anchor = useRange && validRange ? { start_ms: range[0], end_ms: range[1] } : { start_ms: currentPosition() };
    if (!draft?.body.trim()) updateDraft({ anchor, body: "" });

    audio.current?.pause();
    setEditor("note");
  }

  function closeComposer() {
    setEditor(undefined);
    composerTrigger.current?.focus();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft?.body.trim()) return;

    if (await feedback.create(draft.anchor, draft.body)) {
      updateDraft(null);
      setRange(undefined);
      closeComposer();
    }
  }

  async function togglePlayback() {
    const player = audio.current;
    if (!player) return;
    if (!player.paused) {
      player.pause();
      return;
    }

    try {
      await player.play();
    } catch {
      setError("재생할 수 없습니다. 연결과 파일 접근 권한을 확인해 주세요.");
    }
  }

  return <div className="review-grid">
    <section className="player-panel" aria-label="음원 플레이어">
      <audio ref={audio} aria-label="버전 재생" preload="metadata" src={path + "/files/playback"}
        onLoadedMetadata={() => {
          setMetadataReady(true);
          if (initialAt !== undefined) seek(initialAt);
        }}
        onTimeUpdate={(event) => setPosition(clamp(event.currentTarget.currentTime * 1000))}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onError={() => setError("재생 파일에 접근하지 못했습니다.")} />
      {error && <div className="row wrap" role="alert"><span className="error">{error}</span>
        <button onClick={() => { setError(""); setAttempt((value) => value + 1); audio.current?.load(); }}>다시 시도</button></div>}
      <ReviewWaveform audio={audio} duration={duration} peaks={peaks} position={position} range={range}
        setRange={setRange} seek={seek} notes={feedback.notes} selectedId={feedback.selected?.id}
        openNote={(note) => { feedback.select(note.id); seek(note.start_ms); }} />
      <div className="row spread wrap player-controls">
        <div className="row wrap">
          <button type="button" className="primary review-play" disabled={!metadataReady} onClick={() => void togglePlayback()}>{playing ? "일시정지" : "재생"}</button>
          <span className="feedback-time">{timecode(position)} / {timecode(duration)}</span>
        </div>
        <label className="row">음량<input type="range" min={0} max={1} step={.05} value={volume} onChange={(event) => {
          const value = Number(event.target.value);
          setVolume(value);
          if (audio.current) audio.current.volume = value;
        }} /></label>
      </div>
      {writable && <div className="row wrap player-actions">
        <button type="button" aria-pressed={!!range} onClick={() => setRange(range ? undefined : [position, position])}>
          {range ? "구간 선택 취소" : "구간 선택"}
        </button>
      </div>}
      {range && writable && <div className="row wrap range-fields">
        {(["시작", "끝"] as const).map((label, index) => <label key={label}>{label} (초)
          <input type="number" min={0} max={duration / 1000} step={.001} value={range[index] / 1000} onChange={(event) => {
            const value = clamp(Number(event.target.value));
            setRange(index === 0 ? [value, range[1]] : [range[0], value]);
          }} />
        </label>)}
        <button disabled={!validRange} onClick={() => compose(true)}>선택 구간에 피드백</button>
      </div>}
    </section>
    <VersionNotes feedback={feedback} url={notesURL} projectId={projectId} itemId={version.item_id}
      versionId={version.id} accountId={accountId} canEdit={canEdit} writable={writable} seek={seek}
      replyActive={typeof editor === "object" && editor.replyTo === feedback.selected?.id}
      onReply={() => {
        if (feedback.selected) setEditor({ replyTo: feedback.selected.id });
        audio.current?.pause();
      }}
      composer={writable && <div className="feedback-composer">
        <button ref={composerTrigger} aria-expanded={composerOpen} disabled={!metadataReady || feedback.busy} onClick={() => composerOpen ? closeComposer() : compose(false)}>
          {composerOpen ? "새 피드백" : draft?.body.trim() ? "피드백 계속 작성" : "이 위치에 피드백 남기기"}
        </button>
        {storageError && <p className="error" role="alert">{storageError}</p>}
        {composerOpen && draft && <FeedbackComposer draft={draft} busy={feedback.busy} error={feedback.error}
          save={save} close={closeComposer} discard={() => { updateDraft(null); closeComposer(); }}
          changeBody={(body) => updateDraft({ ...draft, body })}
          moveAnchor={() => updateDraft({ ...draft, anchor: { start_ms: currentPosition() } })} />}
      </div>} />
  </div>;
}
