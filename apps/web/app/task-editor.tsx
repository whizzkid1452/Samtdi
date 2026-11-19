"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { AppModal } from "./app-modal";
import { timecode } from "../lib/timecode";
import { useWorkspace, type Member } from "./workspace";

export type Task = components["schemas"]["Task"];
export type TaskNote = components["schemas"]["TaskNote"];
export type Status = Task["status"];
type Options = components["schemas"]["TaskOptions"];
type VersionOption = components["schemas"]["TaskVersion"];
export type TaskChange = { status?: Status; position?: number; archived?: boolean };

export const statuses: [Status, string][] = [
  ["todo", "할 일"], ["progress", "진행 중"], ["review", "검토 요청"], ["done", "완료"],
];

export function statusLabel(status: string) {
  return statuses.find(([value]) => value === status)?.[1] ?? status;
}

type TaskDraft = {
  title: string; description: string; assignee: string; due: string; status: Status;
  review: string; resultId: string; notes: TaskNote[]; revision: number;
};

function readTaskDraft(key: string): TaskDraft | null {
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) ?? "null") as TaskDraft | null;
    return draft && typeof draft.title === "string" && Array.isArray(draft.notes) ? draft : null;
  } catch {
    return null;
  }
}

function storeTaskDraft(key: string, draft?: TaskDraft) {
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch {
    // The mounted form still retains its draft if browser storage is unavailable.
  }
}

export function TaskEditor({ base, members, task, seedNote, change, close, saved, returnFocusTo }: {
  base: string; members: Member[]; task?: Task; seedNote?: TaskNote; change?: TaskChange; close: () => void; saved: (id: string) => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const { session } = useWorkspace();
  const key = "samtdi-task-draft:" + session.account_id + ":" + base + ":" +
    (task?.id ?? seedNote?.id ?? "new") + ":" + JSON.stringify(change ?? {});
  const [restored] = useState(() => readTaskDraft(key));
  const [latest, setLatest] = useState(task);
  const [title, setTitle] = useState(restored?.title ?? task?.title ?? seedNote?.body.slice(0, 160) ?? "");
  const [description, setDescription] = useState(restored?.description ?? task?.description ?? "");
  const [assignee, setAssignee] = useState(restored?.assignee ?? task?.assignee_id ?? "");
  const [due, setDue] = useState(restored?.due ?? task?.due_on ?? "");
  const [status, setStatus] = useState<Status>(restored?.status ?? change?.status ?? task?.status ?? "todo");
  const [review, setReview] = useState(restored?.review ?? task?.review_text ?? "");
  const [resultId, setResultId] = useState(restored?.resultId ?? task?.result_version_id ?? "");
  const [notes, setNotes] = useState(restored?.notes ?? task?.notes ?? (seedNote ? [seedNote] : []));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(!!restored);
  const [error, setError] = useState("");
  const [hasConflict, setHasConflict] = useState(!!restored && !!task && restored.revision !== task.revision);
  const [hasReadLatest, setHasReadLatest] = useState(false);
  const unresolved = notes.filter((note) => !note.resolved && !note.deleted);
  const archived = change?.archived ?? task?.archived ?? false;
  const heading = !task ? "새 작업" : change?.archived !== undefined ? (archived ? "작업 보관" : "작업 복원")
    : change?.status ? statusLabel(status) : change?.position !== undefined ? "순서 이동" : "작업 편집";

  useEffect(() => {
    if (!dirty) return;
    const revision = hasConflict && !hasReadLatest ? (restored?.revision ?? task?.revision ?? 0) : (latest?.revision ?? 0);
    storeTaskDraft(key, { title, description, assignee, due, status, review, resultId, notes, revision });
  }, [assignee, description, dirty, due, hasConflict, hasReadLatest, key, latest, notes, restored, resultId, review, status, task, title]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>(base + "/tasks" + (task ? "/" + task.id : ""), {
        method: task ? "PUT" : "POST",
        body: JSON.stringify({
          title, description, assignee_id: assignee, due_on: due, status, review_text: review, result_version_id: resultId,
          position: change?.position, archived, revision: latest?.revision ?? 0, note_ids: notes.map(({ id }) => id),
          confirm_notes: status === "done" && confirm ? unresolved.map(({ id, revision }) => ({ id, revision })) : [],
        }),
      });
      storeTaskDraft(key);
      saved(result.id);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === "review_evidence_required"
        ? "결과 버전 또는 검토 설명을 입력해 주세요." : describeError(cause));
      setHasConflict(cause instanceof ApiError && cause.status === 409);
      setHasReadLatest(false);
    } finally {
      setBusy(false);
    }
  }

  async function loadLatest() {
    if (!task) return;
    setBusy(true);
    try {
      const current = await api<Task>(base + "/tasks/" + task.id);
      const currentNotes = await Promise.all(notes.map(async (note) => {
        const known = current.notes.find(({ id }) => id === note.id);
        if (known) return known;

        const options = await api<Options>(base + "/task-options?note=" + note.id);
        return options.notes[0] ?? note;
      }));

      setLatest(current);
      setNotes(currentNotes);
      setConfirm(false);
      setHasReadLatest(true);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <AppModal title={heading} busy={busy} returnFocusTo={returnFocusTo} close={() => {
    if (busy || (dirty && !window.confirm("저장하지 않은 변경을 버릴까요?"))) return;
    storeTaskDraft(key);
    close();
  }}>
    <form className="task-editor" onSubmit={submit} onChange={() => setDirty(true)}>
      {restored && <p className="muted" role="status">이전에 작성하던 내용을 불러왔습니다.</p>}
      {!change && <>
        <label>작업 제목<input data-autofocus autoComplete="off" value={title} required maxLength={160} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>작업 설명<textarea value={description} maxLength={4000} onChange={(event) => setDescription(event.target.value)} /></label>
        <div className="form-grid">
          <label>담당자<select aria-label="담당자" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            <option value="">미할당</option>
            {members.filter(({ role }) => role !== "reviewer").map(({ account_id, email }) => <option key={account_id} value={account_id}>{email}</option>)}
          </select></label>
          <label>마감일<input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label>
          {task && <label>상태<select value={status} onChange={(event) => { setConfirm(false); setStatus(event.target.value as Status); }}>
            {statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>}
        </div>
      </>}
      {change && <p>{task?.title}</p>}
      {status === "review" && <>
        <label>검토 설명<textarea data-autofocus={!!change || undefined} value={review} maxLength={2000} onChange={(event) => setReview(event.target.value)} /></label>
        <ResultPicker base={base} resultId={resultId} select={(id) => { setDirty(true); setResultId(id); }} />
        <p className="muted">결과 버전 또는 검토 설명을 입력해 주세요.</p>
      </>}
      {notes.length > 0 && <ul className="clean-list">
        {notes.map((note) => <li className="row spread wrap" key={note.id}>
          <span className="message-body">{timecode(note.start_ms)} · {note.deleted ? "삭제된 피드백" : note.body}</span>
          {!change && <button type="button" onClick={() => {
            setNotes(notes.filter(({ id }) => id !== note.id)); setConfirm(false); setDirty(true);
          }}>연결 해제</button>}
        </li>)}
      </ul>}
      {!change && <OptionPicker base={base} kind="note" onNote={(note) => {
        if (notes.some(({ id }) => id === note.id) || notes.length >= 50) return;
        setNotes([...notes, note]); setConfirm(false); setDirty(true);
      }} />}
      {status === "done" && unresolved.length > 0 && <div className="notice">
        <p>미해결 피드백 {unresolved.length}개</p>
        <ul>{unresolved.map((note) => <li key={note.id}>{timecode(note.start_ms)} · {note.body}</li>)}</ul>
        <label className="row"><input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} required />
          미해결 피드백을 확인하고 완료합니다</label>
      </div>}
      {error && <p className="error" role="alert">{error}</p>}
      {hasConflict && (hasReadLatest && latest ? <div className="notice" role="status">
        <p>최신 작업 {latest.title} · {statusLabel(latest.status)}</p>
        <p className="message-body">{latest.description}</p>
        <p>작성 중인 내용으로 반영하려면 다시 저장하세요.</p>
      </div> : <button type="button" disabled={busy} onClick={() => void loadLatest()}>최신 상태 확인</button>)}
      <button className="primary" disabled={busy || !title.trim() || (hasConflict && !hasReadLatest)}>
        {task ? "저장" : "작업 만들기"}
      </button>
    </form>
  </AppModal>;
}

function ResultPicker({ base, resultId, select }: { base: string; resultId: string; select: (id: string) => void }) {
  const [version, setVersion] = useState<VersionOption>();
  useEffect(() => {
    if (!resultId) return;
    const request = new AbortController();

    api<VersionOption>(base + "/versions/" + resultId, { signal: request.signal }).then((value) => {
      if (!request.signal.aborted) setVersion(value);
    }).catch(() => {
      if (!request.signal.aborted) setVersion(undefined);
    });
    return () => request.abort();
  }, [base, resultId]);

  return <div>
    <div className="row wrap">
      <strong>결과 버전</strong>
      <span>{resultId ? (version?.id === resultId ? version.filename : "선택한 버전") : "선택 없음"}</span>
      {resultId && <button type="button" onClick={() => select("")}>선택 해제</button>}
    </div>
    <OptionPicker base={base} kind="version" onVersion={(value) => select(value.id)} />
  </div>;
}

function OptionPicker({ base, kind, onNote, onVersion }: {
  base: string; kind: "note" | "version"; onNote?: (note: TaskNote) => void; onVersion?: (version: VersionOption) => void;
}) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{kind === "note" ? "피드백 연결" : "결과 버전 선택"}</summary>
    {open && <OptionResults base={base} kind={kind} onNote={onNote} onVersion={onVersion} />}
  </details>;
}

function OptionResults({ base, kind, onNote, onVersion }: {
  base: string; kind: "note" | "version"; onNote?: (note: TaskNote) => void; onVersion?: (version: VersionOption) => void;
}) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Options>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const path = base + "/task-options?" + new URLSearchParams({ kind, q: query });

  useEffect(() => {
    const request = new AbortController();

    api<Options>(path, { signal: request.signal }).then((rows) => {
      if (!request.signal.aborted) setOptions(rows);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [path]);

  const rows = kind === "note" ? options?.notes : options?.versions;

  async function more() {
    const cursor = rows?.at(-1)?.id;
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const next = await api<Options>(path + "&before=" + cursor);
      setOptions((previous) => previous ? { notes: [...previous.notes, ...next.notes], versions: [...previous.versions, ...next.versions] } : next);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  function search() {
    if (input.trim() === query) return;
    setOptions(undefined);
    setError("");
    setQuery(input.trim());
  }

  return <div className="option-picker">
    <div className="row wrap">
      <input type="search" aria-label={kind === "note" ? "피드백 검색" : "버전 검색"} maxLength={200} value={input}
        onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); search(); }
        }} />
      <button type="button" disabled={busy} onClick={search}>검색</button>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {!rows && !error && <p role="status">불러오는 중</p>}
    {rows?.length === 0 && <p className="muted">일치하는 항목이 없습니다.</p>}
    <ul className="clean-list">
      {options?.notes.map((note) => <li key={note.id}>
        <button type="button" disabled={note.deleted} onClick={() => onNote?.(note)}>
          {timecode(note.start_ms)} · {note.deleted ? "삭제된 피드백" : note.body}
        </button>
      </li>)}
      {options?.versions.map((version) => <li key={version.id}><button type="button" onClick={() => onVersion?.(version)}>{version.filename}</button></li>)}
    </ul>
    {rows && rows.length > 0 && rows.length % 100 === 0 && <button type="button" disabled={busy} onClick={() => void more()}>더 보기</button>}
  </div>;
}
