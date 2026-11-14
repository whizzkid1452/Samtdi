"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { displayName } from "../lib/people";
import { statusLabel } from "../lib/tasks";
import { versionHref } from "../lib/routes";
import { timecode } from "../lib/timecode";
import { ReviewTaskLinks } from "./review-task-links";
import { readReplyDraft, useFeedbackDraft } from "./feedback-drafts";
import { submitFeedbackShortcut } from "./feedback-shortcut";
import { Avatar, Icon, Menu, Person } from "./ui";

type Message = components["schemas"]["Message"];
export type Note = components["schemas"]["Note"];
type FeedbackPage = { notes: Note[]; path: string; more: boolean };
const pageSize = 100;

export function noteLabel(note: Pick<Note, "start_ms" | "end_ms">) {
  return timecode(note.start_ms) + (note.end_ms == null ? "" : " ~ " + timecode(note.end_ms));
}

export function useVersionNotes({ url, linkedNote }: { url: string; linkedNote?: string }) {
  const query = useSearchParams();
  const requestedFilter = query.get("feedback");
  const filter = requestedFilter === "open" || requestedFilter === "resolved" ? requestedFilter : "";
  const sort = query.get("sort") === "recent" ? "recent" : "time";
  const [page, setPage] = useState<FeedbackPage>();
  const [direct, setDirect] = useState<Note>();
  const [selectedId, setSelectedId] = useState(linkedNote);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const pageRequest = useRef<AbortController | null>(null);
  const path = url + "?" + new URLSearchParams({ filter, sort });
  const currentPage = page?.path === path ? page : undefined;
  const notes = currentPage?.notes;
  const selected = notes?.find(({ id }) => id === selectedId) ?? (direct?.id === selectedId ? direct : undefined);

  useEffect(() => {
    const request = new AbortController();
    api<Note[]>(path, { signal: request.signal }).then((rows) => {
      if (request.signal.aborted) return;
      setPage({ notes: rows, more: rows.length === pageSize, path });
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => {
      request.abort();
      pageRequest.current?.abort();
    };
  }, [path, refresh]);

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

      const current = previous.notes.some(({ id }) => id === note.id);
      if (!current) return previous;

      const params = new URL(previous.path, window.location.origin).searchParams;
      const pageFilter = params.get("filter");
      const included = !pageFilter || (!note.deleted && note.resolved === (pageFilter === "resolved"));
      const notes = included ? previous.notes.map((row) => row.id === note.id ? note : row)
        : previous.notes.filter(({ id }) => id !== note.id);
      return { ...previous, notes };
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
    const note = notes?.find((row) => row.id === id);
    if (note) setDirect(note);
    setError("");
  }

  function setQuery(name: "feedback" | "sort", value: string) {
    const params = new URLSearchParams(window.location.search);
    if (value) params.set(name, value);
    else params.delete(name);

    setError("");
    window.history.pushState(null, "", window.location.pathname + (params.size ? "?" + params : "") + window.location.hash);
  }

  return {
    notes, selected, filter, sort, busy, error, more: currentPage?.more,
    setFilter: (value: string) => setQuery("feedback", value),
    setSort: (value: string) => setQuery("sort", value),
    select,
    retry: () => { setError(""); setRefresh((value) => value + 1); },
    loadMore: () => run(async () => {
      const cursor = currentPage?.notes.at(-1)?.id;
      if (!cursor) return;

      const request = new AbortController();
      pageRequest.current = request;
      try {
        const rows = await api<Note[]>(path + "&" + new URLSearchParams({ after: cursor }), { signal: request.signal });
        if (request.signal.aborted) return;

        setPage((previous) => previous?.path === path
          ? { ...previous, notes: [...previous.notes, ...rows.filter((row) => !previous.notes.some(({ id }) => id === row.id))], more: rows.length === pageSize }
          : previous);
      } catch (cause) {
        if (!request.signal.aborted) throw cause;
      } finally {
        pageRequest.current = null;
      }
    }),
    create: (anchor: { start_ms: number; end_ms?: number }, body: string, task?: { assignee_id: string; due_on: string }) => run(async () => {
      const created = await api<{ id: string; task_id?: string }>(url, { method: "POST", body: JSON.stringify({ ...anchor, body, ...(task && { task }) }) });
      await refreshNote(created.id);
      setRefresh((value) => value + 1);
      select(created.id);
      return created.id;
    }),
    change: (note: Note, target: string, revision: number, payload: object) => run(async () => {
      await api(target, { method: "PATCH", body: JSON.stringify({ revision, ...payload }) });
      await refreshNote(note.id);
      if ("resolved" in payload || "deleted" in payload) setRefresh((value) => value + 1);
      return true;
    }),
    reply: (note: Note, body: string) => run(async () => {
      await api(url + "/" + note.id + "/replies", { method: "POST", body: JSON.stringify({ body }) });
      await refreshNote(note.id);
      return true;
    }),
  };
}

export function VersionNotes({ feedback, url, projectId, itemId, versionId, accountId, canEdit, writable, seek, playRange, pause, replyActive, onReply, composer }: {
  feedback: ReturnType<typeof useVersionNotes>; url: string; projectId: string; itemId: string; versionId: string; accountId: string;
  canEdit: boolean; writable: boolean; seek: (position: number) => void;
  playRange: (range: { start_ms: number; end_ms: number }) => Promise<void>;
  pause: () => void;
  replyActive: boolean; onReply: () => void; composer: ReactNode;
}) {
  const { notes, selected, filter, sort, busy, error } = feedback;

  function open(note: Note) {
    feedback.select(note.id);
    seek(note.start_ms);
  }

  const thread = selected && <FeedbackThread key={selected.id} note={selected} url={url} projectId={projectId} itemId={itemId}
    versionId={versionId} canEdit={canEdit} accountId={accountId} writable={writable}
    feedback={feedback} playRange={playRange} pause={pause} replyActive={replyActive} onReply={onReply} />;

  return <aside className="feedback-panel" aria-label="피드백">
    <div className="row spread wrap">
      <h3>피드백</h3>
      <div className="segmented" aria-label="피드백 필터">
        <button aria-pressed={!filter} onClick={() => feedback.setFilter("all")}>전체</button>
        <button aria-pressed={filter === "open"} onClick={() => feedback.setFilter("open")}>미해결</button>
        <button aria-pressed={filter === "resolved"} onClick={() => feedback.setFilter("resolved")}>해결됨</button>
      </div>
    </div>
    <div className="row wrap feedback-sort">
      <label>정렬 <select value={sort} onChange={(event) => feedback.setSort(event.target.value)}>
        <option value="time">시간순</option>
        <option value="recent">최신순</option>
      </select></label>
    </div>
    {composer}
    {error && <div role="alert"><p className="error">{error}</p><button onClick={feedback.retry}>다시 시도</button></div>}
    {!notes && !error && <p role="status">피드백을 불러오는 중</p>}
    {notes?.length === 0 && <p className="muted">{filter === "resolved" ? "해결된 피드백이 없습니다." : filter === "open" ? "미해결 피드백이 없습니다." : "이 버전에 남긴 피드백이 없습니다."}</p>}
    <ul className="feedback-list">
      {notes?.map((note) => <li key={note.id}>
        <button type="button" aria-expanded={selected?.id === note.id} onClick={() => selected?.id === note.id ? feedback.select(undefined) : open(note)}>
          <span className="feedback-meta">
            <Avatar id={note.author_id} person={note} />
            <span className="feedback-author">{displayName(note)}</span>
            <span className="feedback-time time-chip">{noteLabel(note)}</span>
          </span>
          <span className="feedback-summary">{note.deleted ? "삭제된 피드백" : note.body}</span>
          {note.tasks.length > 0 && <span className="note-tasks">{note.tasks.map((task) => <span key={task.id} className={"note-task status-chip status-" + task.status}>
            <span className="status-dot" aria-hidden="true" /><span className="visually-hidden">작업 {statusLabel(task.status)}: </span>{task.title}</span>)}</span>}
          <span className="feedback-meta">
            {note.resolved && <span className="status-label status-resolved"><Icon name="check" size={12} />해결됨</span>}
            {note.replies.some(({ deleted }) => !deleted) && <span className="muted meta-count"><Icon name="message" size={14} />답글 {note.replies.filter(({ deleted }) => !deleted).length}</span>}
          </span>
        </button>
        {selected?.id === note.id && thread}
      </li>)}
    </ul>
    {feedback.more && <div className="row wrap">
      <span className="muted">불러온 피드백 {notes?.length}개 표시</span>
      <button disabled={busy} onClick={() => void feedback.loadMore()}>피드백 더 보기</button>
    </div>}
    {selected && !notes?.some(({ id }) => id === selected.id) && <>
      <p className="muted">현재 목록 밖의 피드백</p>
      {thread}
    </>}
  </aside>;
}

function FeedbackThread({ note, url, projectId, itemId, versionId, canEdit, accountId, writable, feedback, playRange, pause, replyActive, onReply }: {
  note: Note; url: string; projectId: string; itemId: string; versionId: string; canEdit: boolean; accountId: string;
  writable: boolean; feedback: ReturnType<typeof useVersionNotes>;
  playRange: (range: { start_ms: number; end_ms: number }) => Promise<void>;
  pause: () => void;
  replyActive: boolean; onReply: () => void;
}) {
  const target = url + "/" + note.id;
  const link = versionHref({ projectId, itemId, versionId, noteId: note.id, at: note.start_ms });
  const key = "samtdi-reply:" + accountId + ":" + versionId + ":" + note.id;
  const { draft: reply, updateDraft, storageError } = useFeedbackDraft({ key, read: () => readReplyDraft(key) });
  const replyInput = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (replyActive) replyInput.current?.focus();
  }, [replyActive]);

  function editor(message: Message, endpoint: string) {
    if (!writable || message.author_id !== accountId || message.deleted) return null;
    return <MessageEditor message={message} busy={feedback.busy}
      change={(payload) => feedback.change(note, endpoint, message.revision, payload)} />;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reply?.trim() && await feedback.reply(note, reply)) updateDraft(null);
  }

  return <section className="feedback-thread" id={"note-" + note.id} aria-label="선택한 피드백">
    <div className="row spread wrap">
      <strong className="feedback-time">{noteLabel(note)}</strong>
      <button type="button" onClick={() => feedback.select(undefined)}>대화 닫기</button>
    </div>
    <Person id={note.author_id} person={note} />
    <p className="message-body">{note.deleted ? "삭제된 피드백" : note.body}</p>
    <div className="row wrap">
      <Link href={link}>피드백 링크</Link>
      {note.end_ms != null && !note.deleted && <button type="button" onClick={() => {
        if (note.end_ms != null) void playRange({ start_ms: note.start_ms, end_ms: note.end_ms });
      }}>구간 듣기</button>}
      {writable && !note.deleted && (canEdit || note.author_id === accountId) && <button disabled={feedback.busy}
        onClick={() => void feedback.change(note, target, note.revision, { resolved: !note.resolved })}>
        {note.resolved ? "다시 열기" : "해결"}
      </button>}
    </div>
    <ReviewTaskLinks projectId={projectId} note={note} canCreate={writable && canEdit && !note.deleted} pause={pause} />
    {editor(note, target)}
    <ul className="clean-list replies">
      {note.replies.map((entry) => <li key={entry.id}>
        <Person id={entry.author_id} person={entry} />
        <p className="message-body">{entry.deleted ? "삭제된 답글" : entry.body}</p>
        {editor(entry, target + "/replies/" + entry.id)}
      </li>)}
    </ul>
    {storageError && <p className="error" role="alert">{storageError}</p>}
    {writable && !note.deleted && (replyActive
      ? <form className="notes-form" onSubmit={submit}>
        <textarea ref={replyInput} aria-label="답글" placeholder="답글 쓰기" maxLength={4000} required
          readOnly={feedback.busy} value={reply ?? ""} onChange={(event) => updateDraft(event.target.value)} onKeyDown={submitFeedbackShortcut} />
        <div className="row wrap">
          <button disabled={feedback.busy || !reply?.trim()}>답글 남기기</button>
          {reply?.trim() && <button type="button" disabled={feedback.busy} onClick={() => updateDraft(null)}>답글 초안 버리기</button>}
        </div>
      </form>
      : <button type="button" disabled={feedback.busy} onClick={onReply}>{reply?.trim() ? "답글 계속 작성" : "답글"}</button>)}
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

  return <Menu className="message-menu" align="start" buttonLabel="더 보기" buttonClassName="icon-button" label={<Icon name="more" />}>
    {(close) => <div className="menu-list">
      <button className="menu-item" onClick={() => { close(); setBody(message.body); }}>수정</button>
      <button className="menu-item danger" disabled={busy} onClick={() => {
        close();
        if (window.confirm("이 내용을 삭제할까요?")) void change({ deleted: true });
      }}>삭제</button>
    </div>}
  </Menu>;
}
