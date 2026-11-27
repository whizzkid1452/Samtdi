"use client";

import { Button, Slider } from "@mantine/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import { timecode } from "../lib/timecode";
import { ReviewRangeInput } from "./review-range-input";
import { ReviewWaveform } from "./review-waveform";
import { FeedbackComposer } from "./feedback-composer";
import { feedbackDraftKey, readFeedbackDraft, useFeedbackDraft, type FeedbackDraft } from "./feedback-drafts";
import { VersionNotes, useVersionNotes } from "./version-notes";
import { useProjectMembers } from "./members";
import type { MediaVersion } from "./media-library";
import { InlineError } from "./request-states";

export function VersionReview({ base, version, initialAt, initialNote, projectId, accountId, canEdit, writable }: {
  base: string; version: MediaVersion; initialAt?: number; initialNote?: string;
  projectId: string; accountId: string; canEdit: boolean; writable: boolean;
}) {
  const path = base + "/versions/" + version.id;
  const notesURL = path + "/notes";
  const duration = version.duration_ms ?? 0;
  const key = feedbackDraftKey(accountId, version.id);
  const audio = useRef<HTMLAudioElement>(null);
  const previewEnd = useRef<number | null>(null);
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
  const { members, error: memberError } = useProjectMembers(canEdit && writable && composerOpen ? projectId : undefined);
  const assignees = members.filter(({ role }) => role !== "reviewer");
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
    if (previewEnd.current !== null) {
      previewEnd.current = null;
      audio.current.pause();
    }

    const next = clamp(ms);
    if (audio.current.currentTime !== next / 1000) audio.current.currentTime = next / 1000;
    setPosition(next);
  }

  function pausePlayback() {
    previewEnd.current = null;
    audio.current?.pause();
  }

  function currentPosition() {
    return clamp((audio.current?.currentTime ?? 0) * 1000);
  }

  function clearRange() {
    if (previewEnd.current !== null) pausePlayback();
    setRange(undefined);
  }

  function compose(useRange: boolean) {
    const anchor = useRange && validRange ? { start_ms: range[0], end_ms: range[1] } : { start_ms: currentPosition() };
    if (!draft?.body.trim()) updateDraft({ anchor, body: "" });

    pausePlayback();
    setEditor("note");
  }

  function closeComposer() {
    setEditor(undefined);
    composerTrigger.current?.focus();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft?.body.trim()) return;

    if (await feedback.create(draft.anchor, draft.body, canEdit && writable ? draft.task : undefined)) {
      updateDraft(null);
      setRange(undefined);
      closeComposer();
    }
  }

  async function playRange({ start_ms, end_ms }: { start_ms: number; end_ms: number }) {
    const player = audio.current;
    if (!player || !metadataReady || end_ms <= start_ms) return;

    seek(start_ms);
    previewEnd.current = end_ms;
    try {
      await player.play();
    } catch {
      previewEnd.current = null;
      setError("구간을 재생할 수 없습니다. 파일 연결을 확인해 주세요.");
    }
  }

  async function togglePlayback() {
    const player = audio.current;
    if (!player) return;
    if (!player.paused) {
      previewEnd.current = null;
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
    <section className="player-panel" aria-label="음원 플레이어" onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented && range) clearRange();
    }}>
      <audio ref={audio} aria-label="버전 재생" preload="metadata" src={path + "/files/playback"}
        onLoadedMetadata={() => {
          setMetadataReady(true);
          if (initialAt !== undefined) seek(initialAt);
        }}
        onTimeUpdate={(event) => setPosition(clamp(event.currentTarget.currentTime * 1000))}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { previewEnd.current = null; setPlaying(false); }}
        onError={() => setError("재생 파일에 접근하지 못했습니다.")} />
      {error && <InlineError message={error} retry={() => {
        setError("");
        setAttempt((value) => value + 1);
        audio.current?.load();
      }} />}
      <ReviewWaveform audio={audio} duration={duration} peaks={peaks} position={position} range={range}
        setRange={setRange} seek={seek} notes={feedback.notes} selected={feedback.selected} previewEnd={previewEnd}
        onError={setError} togglePlayback={() => { if (metadataReady) void togglePlayback(); }}
        openNote={(note) => { feedback.select(note.id); seek(note.start_ms); }} />
      <div className="row spread wrap player-controls">
        <div className="row wrap">
          <Button type="button" className="review-play" disabled={!metadataReady} onClick={() => void togglePlayback()}>{playing ? "일시정지" : "재생"}</Button>
          <span className="feedback-time">{timecode(position)} / {timecode(duration)}</span>
        </div>
        <div className="row volume-control">
          <span aria-hidden="true">음량</span>
          <Slider className="volume-slider" thumbLabel="음량" min={0} max={100} step={5}
            value={Math.round(volume * 100)} label={(value) => value + "%"} onChange={(percent) => {
              const value = percent / 100;
              setVolume(value);
              if (audio.current) audio.current.volume = value;
            }} />
        </div>
      </div>
      <div className="row wrap player-actions">
        <Button variant="default" type="button" aria-pressed={!!range} disabled={!metadataReady || !duration}
          onClick={() => {
            if (range) clearRange();
            else {
              const at = currentPosition();
              setRange([at, at]);
            }
          }}>
          {range ? "구간 해제" : "구간 지정"}
        </Button>
      </div>
      {range && <div className="row wrap range-fields">
        <p className="muted">파형에서 구간을 드래그하거나 시작·끝 시간을 입력하세요.</p>
        {(["시작", "끝"] as const).map((label, index) => <ReviewRangeInput key={label} label={label}
          duration={duration} value={range[index]} change={(milliseconds) => {
            const value = clamp(milliseconds);
            setRange(index === 0 ? [value, range[1]] : [range[0], value]);
          }} />)}
        <Button variant="default" type="button" disabled={!validRange || !metadataReady}
          onClick={() => void playRange({ start_ms: range[0], end_ms: range[1] })}>구간 듣기</Button>
        {writable && <Button variant="default" type="button" disabled={!validRange || feedback.busy || !metadataReady}
          onClick={() => compose(true)}>구간에 피드백</Button>}
      </div>}
    </section>
    <VersionNotes feedback={feedback} url={notesURL} projectId={projectId} itemId={version.item_id}
      versionId={version.id} accountId={accountId} canEdit={canEdit} writable={writable} seek={seek} playRange={playRange} pause={pausePlayback}
      replyActive={typeof editor === "object" && editor.replyTo === feedback.selected?.id}
      onReply={() => {
        if (feedback.selected) setEditor({ replyTo: feedback.selected.id });
        pausePlayback();
      }}
      composer={writable && <div className="feedback-composer">
        <Button variant="default" ref={composerTrigger} aria-expanded={composerOpen} disabled={!metadataReady || feedback.busy} onClick={() => composerOpen ? closeComposer() : compose(false)}>
          {composerOpen ? "새 피드백" : draft?.body.trim() ? "피드백 계속 작성" : "이 위치에 피드백 남기기"}
        </Button>
        {storageError && <InlineError message={storageError} />}
        {composerOpen && draft && <FeedbackComposer draft={draft} busy={feedback.busy} error={feedback.error || memberError}
          save={save} close={closeComposer} discard={() => { updateDraft(null); closeComposer(); }}
          changeBody={(body) => updateDraft({ ...draft, body })}
          moveAnchor={() => updateDraft({ ...draft, anchor: { start_ms: currentPosition() } })}
          assignees={canEdit && writable ? assignees : undefined}
          changeTask={(task) => updateDraft(task ? { ...draft, task } : { anchor: draft.anchor, body: draft.body })} />}
      </div>} />
  </div>;
}
