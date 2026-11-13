"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import { timecode } from "./version-review";

export type Message = { id: string; author_id: string; email: string; body: string; deleted: boolean; revision: number };
export type Note = Message & {
  version_id: string; start_ms: number; end_ms?: number; resolved: boolean; replies: Message[];
};

type Props = {
  path: string; projectId: string; versionId: string; accountId: string; initialNote?: string;
  canEdit: boolean; writable: boolean; position: number; start?: number; end?: number; seek: (ms: number) => void;
};

export function VersionNotes({ path, projectId, versionId, accountId, initialNote, canEdit, writable, position, start, end, seek }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [range, setRange] = useState(false);
  const [body, setBody] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const selectedRange = start !== undefined && end !== undefined && end > start;
  const url = path + "/notes";

  useEffect(() => {
    const request = new AbortController();
    api<Note[]>(url, { signal: request.signal }).then((value) => {
      if (request.signal.aborted) return;
      setNotes(value);
      setHasMore(value.length === 100);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [url]);

  async function change(action: () => Promise<void>) {
    setError("");
    setSaving(true);
    try {
      await action();
      const result = await api<Note[]>(url);
      setNotes(result);
      setHasMore(result.length === 100);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const anchor = range && selectedRange
      ? { start_ms: Math.round(start), end_ms: Math.round(end) }
      : { start_ms: Math.round(position) };
    await change(async () => {
      await api(url, { method: "POST", body: JSON.stringify({ ...anchor, body }) });
      setBody("");
    });
  }

  function updateMessage(target: string, message: Message, data: object) {
    return change(() => api(target, { method: "PATCH", body: JSON.stringify({ revision: message.revision, ...data }) }));
  }

  function messageEditor(target: string, message: Message) {
    if (!writable || message.author_id !== accountId || message.deleted) return null;
    return <details>
      <summary>수정·삭제</summary>
      <form className="row wrap" onSubmit={(event) => {
        event.preventDefault();
        void updateMessage(target, message, { body: new FormData(event.currentTarget).get("body") });
      }}>
        <textarea key={message.revision} name="body" aria-label="글 수정" defaultValue={message.body} maxLength={4000} required />
        <button disabled={saving}>수정 저장</button>
        <button type="button" disabled={saving} onClick={() => void updateMessage(target, message, { deleted: true })}>삭제 표시</button>
      </form>
    </details>;
  }

  return (
    <section className="notes" aria-label="타임코드 노트">
      <h3>타임코드 노트</h3>
      {error && <p role="alert" className="error">{error}</p>}
      {writable && <form className="notes-form" onSubmit={create}>
        <div className="row wrap">
          <span>위치 {timecode(range && selectedRange ? start : position)}</span>
          {selectedRange && <label><input type="checkbox" checked={range} onChange={(event) => setRange(event.target.checked)} /> 선택 구간 사용</label>}
        </div>
        <textarea aria-label="새 노트" value={body} onChange={(event) => setBody(event.target.value)}
          placeholder="이 위치에 남길 피드백" maxLength={4000} required />
        <button className="primary" disabled={saving}>노트 남기기</button>
      </form>}
      {notes.length === 0 && <p className="muted">이 버전에 남긴 노트가 없습니다.</p>}
      <ul className="clean-list">
        {notes.map((note) => {
          const target = url + "/" + note.id;
          const link = "/?" + new URLSearchParams({ project: projectId, version: versionId, note: note.id, at: String(note.start_ms) });
          return (
            <li key={note.id} id={"note-" + note.id} data-highlighted={note.id === initialNote}>
              <div className="row wrap">
                <button onClick={() => seek(note.start_ms)}>{timecode(note.start_ms)}{note.end_ms === undefined ? "" : " ~ " + timecode(note.end_ms)}</button>
                <span className="muted">{note.email}</span>
                {note.resolved && <span>해결됨</span>}
                <a href={link}>노트 링크</a>
                {writable && canEdit && <a href={link + "&task_note=" + note.id + "#task-board"}>작업으로 연결</a>}
                {writable && !note.deleted && (canEdit || note.author_id === accountId) &&
                  <button disabled={saving} onClick={() => void updateMessage(target, note, { resolved: !note.resolved })}>{note.resolved ? "다시 열기" : "해결"}</button>}
              </div>
              <p className="message-body">{note.deleted ? "삭제된 노트" : note.body}</p>
              {messageEditor(target, note)}
              <ul className="clean-list replies">
                {note.replies.map((reply) => <li key={reply.id}>
                  <span className="muted">{reply.email}</span>
                  <p className="message-body">{reply.deleted ? "삭제된 답글" : reply.body}</p>
                  {messageEditor(target + "/replies/" + reply.id, reply)}
                </li>)}
              </ul>
              {writable && !note.deleted && <form className="row wrap" onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const body = new FormData(form).get("body");
                void change(async () => {
                  await api(target + "/replies", { method: "POST", body: JSON.stringify({ body }) });
                  form.reset();
                });
              }}>
                <input aria-label="답글" name="body" placeholder="답글" maxLength={4000} required />
                <button disabled={saving}>답글 남기기</button>
              </form>}
            </li>
          );
        })}
      </ul>
      {hasMore && <button onClick={() => {
        const cursor = notes.at(-1)?.id;
        if (!cursor) return;
        void api<Note[]>(url + "?before=" + cursor).then((result) => {
          setNotes((previous) => [...previous, ...result.filter((note) => !previous.some((entry) => entry.id === note.id))]);
          setHasMore(result.length === 100);
        }).catch((cause) => setError(describeError(cause)));
      }}>노트 더 보기</button>}
    </section>
  );
}
