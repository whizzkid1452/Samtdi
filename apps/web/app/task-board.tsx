"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import { timecode } from "./version-review";
import type { Member, Project } from "./workspace";

const columns = [
  ["todo", "할 일"], ["progress", "진행 중"], ["review", "검토 요청"], ["done", "완료"],
] as const;
type Status = typeof columns[number][0];
export type LinkedNote = { id: string; version_id: string; start_ms: number; body: string; resolved: boolean; deleted: boolean; revision: number };
export type Task = {
  id: string; title: string; description: string; status: Status; assignee_id: string;
  due_on: string; result_version_id: string; review_text: string; position: number;
  archived: boolean; revision: number; notes: LinkedNote[];
};
type Options = { notes: LinkedNote[]; versions: { id: string; filename: string }[] };
type Selection = { task?: Task; status?: Status; position?: number; note?: string };

export function todayInSeoul() {
  return new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeZone: "Asia/Seoul" }).format(new Date());
}

function taskInput(task: Task, extra: object = {}) {
  return {
    title: task.title, description: task.description, status: task.status, assignee_id: task.assignee_id,
    due_on: task.due_on, result_version_id: task.result_version_id, review_text: task.review_text,
    archived: task.archived, revision: task.revision, note_ids: task.notes.map(({ id }) => id), ...extra,
  };
}

function fetchBoard(base: string, signal?: AbortSignal) {
  return Promise.all([
    api<Task[]>(base + "/tasks", { signal }), api<Member[]>(base + "/members", { signal }),
    api<Options>(base + "/task-options", { signal }),
  ]);
}

export function TaskBoard({ project, initialNote, onChange }: { project: Project; initialNote?: string; onChange?: () => void }) {
  const base = `/v1/projects/${project.id}`;
  const canWrite = project.role !== "reviewer" && !project.archived_at;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [options, setOptions] = useState<Options>();
  const [selection, setSelection] = useState<Selection | null>(initialNote ? { note: initialNote } : null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const show = useCallback(([result, team, links]: Awaited<ReturnType<typeof fetchBoard>>) => {
    setTasks(result);
    setHasMore(result.length === 100);
    setMembers(team);
    setOptions(links);
  }, []);

  useEffect(() => {
    const request = new AbortController();
    fetchBoard(base, request.signal).then((result) => {
      if (!request.signal.aborted) show(result);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [base, show]);

  async function load() {
    show(await fetchBoard(base));
  }

  async function persist(task: Task | undefined, data: object) {
    setBusy(true);
    setError("");
    try {
      await api(base + "/tasks" + (task ? "/" + task.id : ""), {
        method: task ? "PUT" : "POST", body: JSON.stringify(data),
      });
      await load();
      setSelection(null);
      onChange?.();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  function card(task: Task, index: number, lane: Task[]) {
    const owner = members.find((member) => member.account_id === task.assignee_id);
    const late = task.due_on && task.due_on < todayInSeoul() && task.status !== "done";
    return <article className="task-card" key={task.id} draggable={canWrite && !task.archived}
      onDragStart={(event) => event.dataTransfer.setData("text/plain", task.id)}>
      <h4>{task.title}</h4>
      {task.description && <p className="message-body">{task.description}</p>}
      <p className={late ? "error" : "muted"}>{owner?.email ?? "미할당"}{task.due_on ? " · " + task.due_on : ""}{late ? " · 지연" : ""}</p>
      {task.notes.map((note) => <a key={note.id} href={"/?" + new URLSearchParams({
        project: project.id, version: note.version_id, note: note.id, at: String(note.start_ms),
      })}>{timecode(note.start_ms)} {note.deleted ? "삭제된 노트" : "노트"} </a>)}
      {task.result_version_id && <a href={"/?" + new URLSearchParams({ project: project.id, version: task.result_version_id })}>결과 버전</a>}
      {task.review_text && <p className="message-body">{task.review_text}</p>}
      {canWrite && <div className="row wrap">
        <button onClick={() => setSelection({ task })}>카드 편집</button>
        <button disabled={!index || busy} aria-label={task.title + " 위로"} onClick={() => {
          const prior = lane[index - 1];
          if (prior) setSelection({ task, position: prior.position });
        }}>위로</button>
        <button onClick={() => setSelection({ task })}>{task.archived ? "복원 설정" : "상태·보관 설정"}</button>
      </div>}
    </article>;
  }

  return <section className="panel" id="task-board" aria-label="작업 보드">
    <div className="row spread"><h2>작업 보드</h2>{canWrite && <button className="primary" onClick={() => setSelection({})}>카드 만들기</button>}</div>
    {error && <div role="alert" className="row wrap error">{error}
      <button onClick={() => void load().then(() => { setSelection(null); setError(""); }).catch((cause) => setError(describeError(cause)))}>최신 상태 보기</button>
    </div>}
    {canWrite && selection && options && <TaskForm key={JSON.stringify(selection)} selection={selection} options={options} members={members}
      busy={busy} close={() => setSelection(null)} save={(data) => void persist(selection.task, data)} />}
    <div className="board">
      {columns.map(([status, label]) => {
        const lane = tasks.filter((task) => task.status === status && !task.archived);
        return <section key={status} aria-label={label} className="lane" onDragOver={(event) => { if (canWrite) event.preventDefault(); }}
          onDrop={(event) => {
            event.preventDefault();
            const task = tasks.find((item) => item.id === event.dataTransfer.getData("text/plain"));
            if (canWrite && task && task.status !== status) setSelection({ task, status });
          }}>
          <h3>{label} <span className="muted">{lane.length}</span></h3>
          {lane.map((task, index) => card(task, index, lane))}
        </section>;
      })}
    </div>
    {tasks.some((task) => task.archived) && <details><summary>보관된 카드</summary>
      {tasks.filter((task) => task.archived).map((task) => card(task, 0, []))}
    </details>}
    {hasMore && <button onClick={() => {
      const cursor = tasks.at(-1)?.id;
      if (!cursor) return;
      void api<Task[]>(base + "/tasks?after=" + cursor).then((rows) => {
        setTasks((old) => [...old, ...rows.filter((row) => !old.some((task) => task.id === row.id))]);
        setHasMore(rows.length === 100);
      }).catch((cause) => setError(describeError(cause)));
    }}>카드 더 보기</button>}
  </section>;
}

function TaskForm({ selection, options, members, busy, close, save }: {
  selection: Selection; options: Options; members: Member[]; busy: boolean;
  close: () => void; save: (data: object) => void;
}) {
  const task = selection.task;
  const [status, setStatus] = useState<Status>(selection.status ?? task?.status ?? "todo");
  const [selected, setSelected] = useState<string[]>(task?.notes.map(({ id }) => id) ?? (selection.note ? [selection.note] : []));
  const linked = [...options.notes, ...(task?.notes ?? []).filter((note) => !options.notes.some(({ id }) => id === note.id))];
  const unresolved = linked.filter((note) => selected.includes(note.id) && !note.resolved && !note.deleted);
  const initialBody = linked.find(({ id }) => id === selection.note)?.body ?? "";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const data = {
      title: fields.get("title"), description: fields.get("description"), status,
      assignee_id: fields.get("assignee"), due_on: fields.get("due_on"),
      result_version_id: fields.get("result"), review_text: fields.get("review"),
      revision: task?.revision ?? 0, archived: fields.has("archived"), position: selection.position,
      note_ids: selected, confirm_notes: fields.has("confirm") ? unresolved.map(({ id, revision }) => ({ id, revision })) : [],
    };
    save(task ? taskInput(task, data) : data);
  }

  return <form className="task-form" onSubmit={submit}>
    <h3>{task ? "카드 편집" : "새 작업 카드"}</h3>
    <div className="form-grid">
      <label>카드 제목<input name="title" defaultValue={task?.title ?? initialBody.slice(0, 160)} maxLength={160} required /></label>
      <label>작업 상태<select value={status} onChange={(event) => setStatus(event.target.value as Status)}>{columns.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>담당자<select name="assignee" defaultValue={task?.assignee_id ?? ""}><option value="">미할당</option>
        {members.filter((member) => member.role !== "reviewer").map((member) => <option key={member.account_id} value={member.account_id}>{member.email}</option>)}</select></label>
      <label>마감일<input name="due_on" type="date" defaultValue={task?.due_on ?? ""} /></label>
      <label>작업 설명<textarea name="description" maxLength={4000} defaultValue={task?.description ?? ""} /></label>
      <label>검토 설명<textarea name="review" maxLength={2000} defaultValue={task?.review_text ?? ""} /></label>
      <label>결과 버전<select name="result" defaultValue={task?.result_version_id ?? ""}><option value="">선택 안 함</option>
        {task?.result_version_id && !options.versions.some(({ id }) => id === task.result_version_id) && <option value={task.result_version_id}>기존 결과 버전</option>}
        {options.versions.map((version) => <option key={version.id} value={version.id}>{version.filename}</option>)}
      </select></label>
    </div>
    {linked.length > 0 && <details open={!!selection.note}><summary>연결할 노트</summary>
      {linked.map((note) => <label className="row" key={note.id}><input type="checkbox" checked={selected.includes(note.id)} onChange={(event) =>
        setSelected((ids) => event.target.checked ? [...ids, note.id] : ids.filter((id) => id !== note.id))} />
        {timecode(note.start_ms)} · {note.deleted ? "삭제된 노트" : note.body}</label>)}
    </details>}
    {task && <label className="row"><input type="checkbox" name="archived" defaultChecked={task.archived} /> 카드 보관</label>}
    {status === "done" && unresolved.length > 0 && <label className="row"><input type="checkbox" name="confirm" required /> 미해결 노트 {unresolved.length}개를 확인하고 완료합니다</label>}
    <div className="row"><button className="primary" disabled={busy}>카드 저장</button><button type="button" onClick={close}>취소</button></div>
  </form>;
}
