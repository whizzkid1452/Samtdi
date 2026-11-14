"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { displayName } from "../lib/people";
import { projectHref, taskHref, versionLink } from "../lib/routes";
import { todayInSeoul } from "../lib/tasks";
import { TaskEditor, statuses, type Status, type Task, type TaskChange, type TaskNote } from "./task-editor";
import { timecode } from "../lib/timecode";
import { useProjectMembers } from "./members";
import { DueChip, Icon, Menu, Person, StatusChip, Unassigned } from "./ui";
import type { Member, Project } from "./workspace";

type Counts = Record<Status, number>;
type TaskSelection = { task?: Task; change?: TaskChange };
const pageSize = 100;

export { todayInSeoul };

export function Assignee({ members, id }: { members: Member[]; id?: string }) {
  const member = members.find(({ account_id }) => account_id === id);
  return member ? <Person id={member.account_id} person={member} /> : <Unassigned />;
}

function taskFilters(query: URLSearchParams) {
  const params = new URLSearchParams();
  const search = query.get("q");
  const status = query.get("status");
  const assignee = query.get("assignee");
  const due = query.get("due");
  const view = query.get("view");
  if (search) params.set("q", search.slice(0, 200));
  if (status && statuses.some(([value]) => value === status)) params.set("status", status);
  if (assignee && (assignee === "unassigned" || /^[0-9a-f-]{36}$/.test(assignee))) params.set("assignee", assignee);
  if (due && ["late", "soon", "none"].includes(due)) params.set("due", due);
  if (query.get("archived") === "true") params.set("archived", "true");
  if (view === "board") params.set("view", view);
  return params;
}

export function TaskBoard({ project, initialNote }: { project: Project; initialNote?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const query = useSearchParams();
  const filters = taskFilters(new URLSearchParams(query));
  const board = filters.get("view") === "board";
  const [input, setInput] = useState(filters.get("q") ?? "");
  const [selection, setSelection] = useState<TaskSelection>();
  const [seedNote, setSeedNote] = useState<TaskNote>();
  const [error, setError] = useState("");
  const [counts, setCounts] = useState<Counts>();
  const [revision, setRevision] = useState(0);
  const base = "/v1/projects/" + project.id;
  const { members, error: memberError } = useProjectMembers(project.id);
  const canWrite = project.role !== "reviewer" && !project.archived_at;
  const detailQuery = filters.size ? "?" + filters : "";
  const apiFilters = new URLSearchParams(filters);
  apiFilters.delete("view");
  if (!apiFilters.has("archived")) apiFilters.set("archived", "false");
  const queryString = apiFilters.toString();

  useEffect(() => {
    if (!initialNote || !canWrite) return;
    const request = new AbortController();

    api<components["schemas"]["TaskOptions"]>(base + "/task-options?note=" + encodeURIComponent(initialNote), { signal: request.signal })
      .then(({ notes }) => {
        if (request.signal.aborted) return;
        if (notes[0] && !notes[0].deleted) { setSeedNote(notes[0]); setSelection({}); }
        else setError("연결할 피드백을 찾을 수 없습니다.");
      })
      .catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [base, canWrite, initialNote]);

  useEffect(() => {
    const request = new AbortController();

    api<Counts>(base + "/task-counts?" + queryString, { signal: request.signal }).then((value) => {
      if (!request.signal.aborted) setCounts(value);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [base, queryString, revision]);

  function href(name: string, value: string) {
    const params = new URLSearchParams(filters);
    if (value) params.set(name, value);
    else params.delete(name);
    return pathname + (params.size ? "?" + params : "");
  }

  function close() {
    setSelection(undefined);
    setSeedNote(undefined);
    if (initialNote) router.replace(pathname + detailQuery);
  }

  function openDetail(id: string) {
    router.push(taskHref(project.id, id) + detailQuery);
  }

  function taskCard(task: Task, previous?: Task) {
    const link = taskHref(project.id, task.id) + detailQuery;
    return <article className={board ? "task-card" : "task-list-row"} draggable={board && canWrite && !task.archived}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.effectAllowed = "move";
      }}>
      <Link href={link} className="resource-title">{task.title}</Link>
      {!board && <StatusChip status={task.status} />}
      <Assignee members={members} id={task.assignee_id} />
      <DueChip due={task.due_on} status={task.status} empty="마감 없음" />
      <span className="muted meta-count" title="연결 피드백"><Icon name="message" size={14} />{task.notes.length}<span className="visually-hidden">개 피드백</span></span>
      {canWrite && <Menu className="task-menu" buttonLabel={task.title + " 관리"} buttonClassName="icon-button" label={<Icon name="more" />}>
        {(close) => <div className="menu-list">
          {previous && <button type="button" className="menu-item" onClick={() => { close(); setSelection({ task, change: { position: previous.position } }); }}><Icon name="up" />위로 이동</button>}
          {statuses.filter(([value]) => value !== task.status).map(([value, label]) => <button type="button" className="menu-item" key={value}
            onClick={() => { close(); setSelection({ task, change: { status: value } }); }}><span className={"status-dot status-" + value} aria-hidden="true" />{label}으로 이동</button>)}
          <button type="button" className="menu-item" onClick={() => { close(); setSelection({ task, change: { archived: !task.archived } }); }}>{task.archived ? "복원" : "보관"}</button>
        </div>}
      </Menu>}
    </article>;
  }

  async function drop(id: string, status: Status) {
    try {
      const task = await api<Task>(base + "/tasks/" + encodeURIComponent(id));
      if (task.status !== status && !task.archived) setSelection({ task, change: { status } });
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return <section id="task-board" aria-label="작업">
    <div className="row spread wrap section-header">
      <h2 className="section-title">작업</h2>
      {canWrite && <button className="primary" onClick={() => setSelection({})}>새 작업</button>}
    </div>
    <div className="row wrap">
      <div className="segmented" aria-label="작업 보기">
        <Link className="button" href={href("view", "")} aria-current={!board ? "page" : undefined}>목록</Link>
        <Link className="button" href={href("view", "board")} aria-current={board ? "page" : undefined}>보드</Link>
      </div>
      <form className="row wrap" onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        router.push(href("q", input.trim()));
      }}>
        <input type="search" aria-label="작업 검색" placeholder="작업 검색" maxLength={200} value={input} onChange={(event) => setInput(event.target.value)} />
        <button>검색</button>
      </form>
    </div>
    <div className="row wrap filter-bar">
      <label>상태 <select value={filters.get("status") ?? ""} onChange={(event) => router.push(href("status", event.target.value))}>
        <option value="">전체</option>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>담당자 <select value={filters.get("assignee") ?? ""} onChange={(event) => router.push(href("assignee", event.target.value))}>
        <option value="">전체</option><option value="unassigned">미할당</option>
        {members.map((member) => <option key={member.account_id} value={member.account_id}>{displayName(member)}</option>)}
      </select></label>
      <label>마감 <select value={filters.get("due") ?? ""} onChange={(event) => router.push(href("due", event.target.value))}>
        <option value="">전체</option><option value="soon">7일 내</option><option value="late">지연</option><option value="none">마감 없음</option>
      </select></label>
      <label className="row"><input type="checkbox" checked={filters.get("archived") === "true"}
        onChange={(event) => router.push(href("archived", event.target.checked ? "true" : ""))} />보관된 작업</label>
      {filters.size > (board ? 1 : 0) && <Link href={pathname + (board ? "?view=board" : "")}>필터 초기화</Link>}
    </div>
    {(error || memberError) && <p role="alert" className="error">{error || memberError}</p>}
    {board ? <div className="board">
      {statuses.filter(([value]) => !filters.get("status") || filters.get("status") === value).map(([value, label]) => {
        const lane = new URLSearchParams(queryString);
        lane.set("status", value);
        return <section className="lane" key={value} aria-label={label} onDragOver={canWrite ? (event) => event.preventDefault() : undefined}
          onDrop={canWrite ? (event) => {
            event.preventDefault();
            const id = event.dataTransfer.getData("text/plain");
            if (/^[0-9a-f-]{36}$/.test(id)) void drop(id, value);
          } : undefined}>
          <h3 className="lane-title"><span className={"status-dot status-" + value} aria-hidden="true" />{label} {counts && <span className="lane-count">{counts[value]}</span>}</h3>
          <TaskRows key={lane.toString() + ":" + revision} path={base + "/tasks?" + lane} render={taskCard} />
        </section>;
      })}
    </div> : <div className="task-list">
      <TaskRows key={queryString + ":" + revision} path={base + "/tasks?" + queryString} render={taskCard} />
    </div>}
    {selection && canWrite && <TaskEditor base={base} members={members} task={selection.task} seedNote={seedNote} change={selection.change}
      close={close} saved={(id) => {
        close();
        setRevision((value) => value + 1);
        if (!selection.task) openDetail(id);
      }} />}
  </section>;
}

function TaskRows({ path, render }: { path: string; render: (task: Task, previous?: Task) => ReactNode }) {
  const [rows, setRows] = useState<Task[]>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const request = new AbortController();

    api<Task[]>(path, { signal: request.signal }).then((value) => {
      if (request.signal.aborted) return;
      setRows(value);
      setMore(value.length === pageSize);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [attempt, path]);

  async function loadMore() {
    const cursor = rows?.at(-1)?.id;
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const next = await api<Task[]>(path + "&after=" + cursor);
      setRows((previous) => [...(previous ?? []), ...next.filter((task) => !previous?.some(({ id }) => id === task.id))]);
      setMore(next.length === pageSize);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoading(false);
    }
  }

  return <>
    {error && <div className="row wrap" role="alert"><span className="error">{error}</span>
      <button onClick={() => { setError(""); setAttempt((value) => value + 1); }}>다시 시도</button></div>}
    {!rows && !error && <p role="status">작업을 불러오는 중</p>}
    {rows?.length === 0 && <p className="empty muted">표시할 작업이 없습니다.</p>}
    {rows && rows.length > 0 && <ul className="task-rows">
      {rows.map((task, index) => {
        const previous = rows[index - 1];
        return <li key={task.id}>{render(task, previous?.status === task.status ? previous : undefined)}</li>;
      })}
    </ul>}
    {more && <button disabled={loading} onClick={() => void loadMore()}>작업 더 보기</button>}
  </>;
}

export function TaskDetail({ project, taskId }: { project: Project; taskId: string }) {
  const base = "/v1/projects/" + project.id;
  const { members, error: memberError } = useProjectMembers(project.id);
  const params = taskFilters(new URLSearchParams(useSearchParams()));
  const [task, setTask] = useState<Task>();
  const [change, setChange] = useState<TaskChange | null>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const canWrite = project.role !== "reviewer" && !project.archived_at;
  const back = projectHref(project.id, "tasks") + (params.size ? "?" + params : "");

  useEffect(() => {
    const request = new AbortController();

    api<Task>(base + "/tasks/" + encodeURIComponent(taskId), { signal: request.signal }).then((value) => {
      if (!request.signal.aborted) setTask(value);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [base, revision, taskId]);

  const nextStatus = task ? ({ todo: "progress", progress: "review", review: "done", done: "todo" } as const)[task.status] : undefined;
  const nextLabel = nextStatus ? ({ progress: "진행 시작", review: "검토 요청", done: "완료", todo: "다시 열기" } as const)[nextStatus] : undefined;

  return <section aria-label="작업 상세">
    <Link href={back}>작업 목록</Link>
    {(error || memberError) && <div role="alert"><p className="error">{error || memberError}</p>
      <button onClick={() => { setError(""); setRevision((value) => value + 1); }}>다시 시도</button></div>}
    {!task && !error && <p role="status">작업을 불러오는 중</p>}
    {task && <>
      <div className="row spread wrap section-header task-detail-title">
        <h2 className="section-title">{task.title}</h2>
        {canWrite && <div className="row wrap">
          {!task.archived && nextStatus && <button className="primary" onClick={() => setChange({ status: nextStatus })}>{nextLabel}</button>}
          {!task.archived && <button onClick={() => setChange(null)}>작업 편집</button>}
          <Menu buttonLabel="작업 관리" buttonClassName="icon-button" label={<Icon name="more" />}>{(close) => <div className="menu-list">
            <button className="menu-item" onClick={() => { close(); setChange({ archived: !task.archived }); }}>{task.archived ? "작업 복원" : "작업 보관"}</button>
          </div>}</Menu>
        </div>}
      </div>
      <div className="task-detail-grid">
        <div>
          {task.description && <p className="message-body">{task.description}</p>}
          <h3>연결한 피드백</h3>
          {task.notes.length === 0 && <p className="muted">연결된 피드백이 없습니다.</p>}
          <ul className="resource-list">
            {task.notes.map((note) => <li key={note.id}>
              <Link href={versionLink(project.id, note.version_id, note.id, note.start_ms)}>{timecode(note.start_ms)} · {note.deleted ? "삭제된 피드백" : note.body}</Link>
              {note.resolved && <span className="status-label status-resolved"><Icon name="check" size={12} />해결됨</span>}
            </li>)}
          </ul>
          {(task.result_version_id || task.review_text) && <section>
            <h3>검토 결과</h3>
            {task.result_version_id && <Link href={versionLink(project.id, task.result_version_id)}>결과 버전 열기</Link>}
            {task.review_text && <p className="message-body">{task.review_text}</p>}
          </section>}
        </div>
        <dl className="task-metadata">
          <dt>상태</dt><dd><StatusChip status={task.status} suffix={task.archived ? " · 보관됨" : ""} /></dd>
          <dt>담당자</dt><dd><Assignee members={members} id={task.assignee_id} /></dd>
          <dt>마감일</dt><dd><DueChip due={task.due_on} status={task.status} empty="마감 없음" /></dd>
        </dl>
      </div>
      {change !== undefined && canWrite && <TaskEditor base={base} members={members} task={task} change={change ?? undefined}
        close={() => setChange(undefined)} saved={() => { setChange(undefined); setRevision((value) => value + 1); }} />}
    </>}
  </section>;
}
