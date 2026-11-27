"use client";

import { Badge, Button, Textarea } from "@mantine/core";
import { useCallback, useRef, useState, type FormEvent } from "react";
import type { LocalNote, LocalVersion } from "../lib/local-review-store";
import { timecode } from "../lib/timecode";
import { ReviewWaveform } from "./review-waveform";
import { noteLabel } from "./version-notes";

export function LocalReview({ version, notes, saveNote }: {
  version: LocalVersion;
  notes: LocalNote[];
  saveNote: (note: LocalNote) => Promise<void>;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const previewEnd = useRef<number | null>(null);
  const [position, setPosition] = useState(0);
  const [range, setRange] = useState<[number, number]>();
  const [selected, setSelected] = useState<string>();
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);

  const active = notes.find((note) => note.id === selected);
  const orderedNotes = [...notes].filter((note) => !note.deleted).sort((a, b) => a.start_ms - b.start_ms);

  const bindAudio = useCallback((element: HTMLAudioElement | null) => {
    audio.current = element;
    if (!element) return;

    const url = URL.createObjectURL(version.preview);
    element.src = url;

    return () => {
      element.pause();
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
      audio.current = null;
    };
  }, [version.preview]);

  function seek(value: number) {
    const at = Math.round(Math.min(version.duration, Math.max(0, value)));
    const player = audio.current;
    if (!player) return;

    previewEnd.current = null;
    player.currentTime = at / 1000;
    setPosition(at);
  }

  function togglePlayback() {
    const player = audio.current;
    if (!player) return;

    if (player.paused) {
      void player.play().catch(() => setError("음원을 재생하지 못했습니다."));
    } else {
      player.pause();
    }
  }

  function openNote(note: LocalNote) {
    setSelected(note.id);
    setRange(undefined);
    seek(note.start_ms);
  }

  async function commitNote(note: LocalNote) {
    if (pending.current) return false;

    pending.current = true;
    setSaving(true);
    setError("");

    try {
      await saveNote(note);
      return true;
    } catch {
      setError("피드백을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.");
      return false;
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;

    const note: LocalNote = {
      id: crypto.randomUUID(),
      version_id: version.id,
      author_id: "local",
      name: "나",
      email: "",
      body: body.trim(),
      deleted: false,
      resolved: false,
      revision: 1,
      start_ms: range?.[0] ?? position,
      end_ms: range && range[1] > range[0] ? range[1] : undefined,
      replies: [],
      tasks: [],
    };

    if (await commitNote(note)) {
      setBody("");
      setRange(undefined);
      setSelected(note.id);
    }
  }

  return <div className="review-grid">
    <section className="panel player-panel">
      <div className="row spread wrap">
        <h2>{version.filename}</h2>
        <Badge color="green" variant="light">브라우저 처리 완료</Badge>
      </div>
      <p className="muted">{timecode(version.duration)} · {version.peaks.length === 2 ? "스테레오" : "모노"} · MP3 미리듣기</p>
      <audio ref={bindAudio} controls preload="metadata" className="local-audio-player" onTimeUpdate={(event) => {
        setPosition(Math.round(Math.min(version.duration, event.currentTarget.currentTime * 1000)));
      }} onError={() => setError("재생용 음원을 불러오지 못했습니다.")} />
      <ReviewWaveform audio={audio} duration={version.duration} peaks={version.peaks} position={position}
        range={range} setRange={setRange} seek={seek} notes={orderedNotes} selected={active} previewEnd={previewEnd}
        openNote={openNote} onError={setError} togglePlayback={togglePlayback} />
      <div className="row spread wrap">
        <strong>{timecode(position)} / {timecode(version.duration)}</strong>
        <Button size="xs" variant="light" onClick={() => {
          setSelected(undefined);
          setRange((previous) => previous ? undefined : [position, Math.min(version.duration, position + 1000)]);
        }}>{range ? "구간 선택 취소" : "구간 피드백"}</Button>
      </div>
      <p className="muted">파형을 클릭하면 재생 위치를 이동합니다. 구간 피드백은 파형에서 드래그해 선택하세요.</p>
    </section>
    <section className="panel">
      <div className="row spread"><h2>피드백</h2><Badge variant="light">{orderedNotes.length}개</Badge></div>
      <form onSubmit={submit} className="local-feedback-form">
        <strong className="feedback-time">{timecode(range?.[0] ?? position)}{range ? " ~ " + timecode(range[1]) : ""}</strong>
        <Textarea aria-label="피드백 내용" placeholder="이 구간에 남길 피드백을 입력하세요." autosize minRows={3} maxRows={8} value={body}
          onChange={(event) => setBody(event.currentTarget.value)} />
        <Button type="submit" disabled={!body.trim() || saving} loading={saving}>피드백 남기기</Button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      {orderedNotes.length === 0 ? <p className="muted">아직 피드백이 없습니다.</p> : <ul className="clean-list local-feedback-list">
        {orderedNotes.map((note) => <li key={note.id}>
          <div className="row spread wrap">
            <Button variant="subtle" size="compact-sm" onClick={() => openNote(note)}>{noteLabel(note)}</Button>
            <Badge color={note.resolved ? "green" : "gray"} variant="light">{note.resolved ? "완료" : "검토 중"}</Badge>
          </div>
          <p>{note.body}</p>
          <Button size="compact-xs" variant="default" disabled={saving} onClick={() => {
            void commitNote({ ...note, resolved: !note.resolved, revision: note.revision + 1 });
          }}>{note.resolved ? "다시 열기" : "완료 처리"}</Button>
        </li>)}
      </ul>}
    </section>
  </div>;
}
