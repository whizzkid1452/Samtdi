"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { projectHref, versionHref } from "../lib/routes";
import { timecode } from "./version-review";

type Message = components["schemas"]["Message"];
export type Note = components["schemas"]["Note"];
type FeedbackPage = { notes: Note[]; filter: string; more: boolean };
const pageSize = 100;

export function noteLabel(note: Pick<Note, "start_ms" | "end_ms">) {
  return timecode(note.start_ms) + (note.end_ms == null ? "" : " ~ " + timecode(note.end_ms));
}

export function useVersionNotes({ url, linkedNote }: { url: string; linkedNote?: string }) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState<FeedbackPage>();
  const [direct, setDirect] = useState<Note>();
  const [selectedId, setSelectedId] = useState(linkedNote);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const path = url + (filter ? "?filter=open" : "");
  const currentPage = page?.filter === filter ? page : undefined;
  const notes = currentPage?.notes;
  const selected = notes?.find(({ id }) => id === selectedId) ?? (direct?.id === selectedId ? direct : undefined);

  useEffect(() => {
    const request = new AbortController();
    api<Note[]>(path, { signal: request.signal }).then((rows) => {
      if (request.signal.aborted) return;
      setPage({ notes: rows, more: rows.length === pageSize, filter });
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [path, filter, refresh]);

  useEffect(() => {
    if (!linkedNote) return;
    const request = new AbortController();

    api<Note>(url + "/" + encodeURIComponent(linkedNote), { signal: request.signal }).then((note) => {
      if (request.signal.aborted) return;
      setDirect(note);
      setSelectedId(note.id);
    }).catch((cause) => {
      if (!request.signal.aborted) setError("피드백을 열 수 없습니다. " + describeError(cause));
    });
    return () => request.abort();
  }, [url, linkedNote]);

  function update(note: Note) {
    setDirect(note);
    setPage((previous) => {
      if (!previous) return previous;
      const rows = previous.notes.filter(({ id }) => id !== note.id);
      if (!previous.filter || (!note.resolved && !note.deleted)) {
        const index = previous.notes.findIndex(({ id }) => id === note.id);
        rows.splice(index < 0 ? 0 : index, 0, note);
      }
      return { ...previous, notes: rows };
    });
  }

  async function run<T>(change: () => Promise<T>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      return await change();
    } catch (cause) {
      setError(describeError(cause));
      if (cause instanceof ApiError && cause.status === 409 && selectedId) {
        try { update(await api<Note>(url + "/" + selectedId)); }
        catch (refreshError) { setError(describeError(refreshError)); }
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function refreshNote(id: string) {
    try {
      update(await api<Note>(url + "/" + id));
    } catch (cause) {
      setError("저장했습니다. " + describeError(cause));
      setRefresh((value) => value + 1);
    }
  }

  function select(id: string | undefined) {
    setSelectedId(id);
    setError("");
  }

  return {
    notes, selected, filter, busy, error, more: currentPage?.more,
    setFilter: (value: string) => { setError(""); setFilter(value); },
    select,
    retry: () => { setError(""); setRefresh((value) => value + 1); },
    loadMore: () => run(async () => {
      const cursor = currentPage?.notes.at(-1)?.id;
      if (!cursor) return;

      const rows = await api<Note[]>(url + "?" + new URLSearchParams({ before: cursor, filter }));
      setPage((previous) => previous?.filter === filter
        ? { ...previous, notes: [...previous.notes, ...rows.filter((row) => !previous.notes.some(({ id }) => id === row.id))], more: rows.length === pageSize }
        : previous);
    }),
    create: (anchor: { start_ms: number; end_ms?: number }, body: string) => run(async () => {
      const created = await api<{ id: string }>(url, { method: "POST", body: JSON.stringify({ ...anchor, body }) });
      await refreshNote(created.id);
      select(created.id);
      return created.id;
    }),
    change: (note: Note, target: string, revision: number, payload: object) => run(async () => {
      await api(target, { method: "PATCH", body: JSON.stringify({ revision, ...payload }) });
      await refreshNote(note.id);
      return true;
    }),
    reply: (note: Note, body: string) => run(async () => {
      await api(url + "/" + note.id + "/replies", { method: "POST", body: JSON.stringify({ body }) });
      await refreshNote(note.id);
      return true;
    }),
  };
}

export function VersionNotes({ feedback, url, projectId, itemId, versionId, accountId, canEdit, writable, seek }: {
  feedback: ReturnType<typeof useVersionNotes>; url: string; projectId: string; itemId: string; versionId: string; accountId: string;
  canEdit: boolean; writable: boolean; seek: (position: number) => void;
}) {
  const { notes, selected, filter, busy, error } = feedback;

  function open(note: Note) {
    feedback.select(note.id);
    seek(note.start_ms);
  }

  return <aside className="feedback-panel" aria-label="피드백">
    <div className="row spread wrap">
      <h3>피드백</h3>
      <div className="segmented" aria-label="피드백 필터">
        <button aria-pressed={filter === "open"} onClick={() => feedback.setFilter("open")}>미해결</button>
        <button aria-pressed={!filter} onClick={() => feedback.setFilter("")}>전체</button>
      </div>
    </div>
    {error && <div role="alert"><p className="error">{error}</p><button onClick={feedback.retry}>다시 시도</button></div>}
    {!notes && !error && <p role="status">피드백을 불러오는 중</p>}
    {notes?.length === 0 && <p className="muted">{filter ? "미해결 피드백이 없습니다." : "이 버전에 남긴 피드백이 없습니다."}</p>}
    <ul className="feedback-list">
      {notes?.map((note) => <li key={note.id}>
        <button type="button" aria-expanded={selected?.id === note.id} onClick={() => open(note)}>
          <span className="feedback-time">{noteLabel(note)}</span>
          <span className="feedback-summary">{note.deleted ? "삭제된 피드백" : note.body}</span>
          {note.resolved && <span className="status-label">해결됨</span>}
        </button>
      </li>)}
    </ul>
    {feedback.more && <button disabled={busy} onClick={() => void feedback.loadMore()}>피드백 더 보기</button>}
    {selected && <FeedbackThread key={selected.id} note={selected} url={url} projectId={projectId} itemId={itemId}
      versionId={versionId} canEdit={canEdit} accountId={accountId} writable={writable} feedback={feedback} />}
  </aside>;
}

function FeedbackThread({ note, url, projectId, itemId, versionId, canEdit, accountId, writable, feedback }: {
  note: Note; url: string; projectId: string; itemId: string; versionId: string; canEdit: boolean; accountId: string;
  writable: boolean; feedback: ReturnType<typeof useVersionNotes>;
}) {
  const target = url + "/" + note.id;
  const link = versionHref({ projectId, itemId, versionId, noteId: note.id, at: note.start_ms });
  const [reply, setReply] = useState("");

  function editor(message: Message, endpoint: string) {
    if (!writable || message.author_id !== accountId || message.deleted) return null;
    return <MessageEditor message={message} busy={feedback.busy}
      change={(payload) => feedback.change(note, endpoint, message.revision, payload)} />;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await feedback.reply(note, reply)) setReply("");
  }

  return <section className="feedback-thread" id={"note-" + note.id} aria-label="선택한 피드백">
    <div className="row spread wrap">
      <strong className="feedback-time">{noteLabel(note)}</strong>
      <button type="button" onClick={() => {
        if (reply.trim() && !window.confirm("작성 중인 답글을 버릴까요?")) return;
        feedback.select(undefined);
      }}>대화 닫기</button>
    </div>
    <p className="muted">{note.email}</p>
    <p className="message-body">{note.deleted ? "삭제된 피드백" : note.body}</p>
    <div className="row wrap">
      <Link href={link}>피드백 링크</Link>
      {writable && canEdit && !note.deleted && <Link href={projectHref(projectId, "tasks") + "?task_note=" + note.id}>작업 만들기</Link>}
      {writable && !note.deleted && (canEdit || note.author_id === accountId) && <button disabled={feedback.busy}
        onClick={() => void feedback.change(note, target, note.revision, { resolved: !note.resolved })}>
        {note.resolved ? "다시 열기" : "해결"}
      </button>}
    </div>
    {editor(note, target)}
    <ul className="clean-list replies">
      {note.replies.map((entry) => <li key={entry.id}>
        <span className="muted">{entry.email}</span>
        <p className="message-body">{entry.deleted ? "삭제된 답글" : entry.body}</p>
        {editor(entry, target + "/replies/" + entry.id)}
      </li>)}
    </ul>
    {writable && !note.deleted && <form className="notes-form" onSubmit={submit}>
      <textarea aria-label="답글" placeholder="답글 쓰기" maxLength={4000} required value={reply} onChange={(event) => setReply(event.target.value)} />
      <button disabled={feedback.busy || !reply.trim()}>답글 남기기</button>
    </form>}
  </section>;
}

function MessageEditor({ message, busy, change }: {
  message: Message; busy: boolean; change: (payload: object) => Promise<boolean | undefined>;
}) {
  const [body, setBody] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await change({ body })) setBody(undefined);
  }

  if (body !== undefined) return <form className="notes-form" onSubmit={submit}>
    <textarea aria-label="피드백 내용 수정" value={body} maxLength={4000} required onChange={(event) => setBody(event.target.value)} />
    <div className="row wrap">
      <button disabled={busy || !body.trim()}>수정 저장</button>
      <button type="button" onClick={() => setBody(undefined)}>취소</button>
    </div>
  </form>;

  return <details className="message-menu">
    <summary>더 보기</summary>
    <div className="row wrap">
      <button onClick={() => setBody(message.body)}>수정</button>
      <button disabled={busy} onClick={() => {
        if (window.confirm("이 내용을 삭제할까요?")) void change({ deleted: true });
      }}>삭제</button>
    </div>
  </details>;
}
