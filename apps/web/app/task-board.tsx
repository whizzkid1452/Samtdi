"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { displayName } from "../lib/people";
import { taskHref } from "../lib/routes";
import { statuses, todayInSeoul } from "../lib/tasks";
import { useProjectMembers } from "./members";
import { createTask, moveTask, type TaskUpdate } from "./task-actions";
import { Assignee, FeedbackCount, SourceChip } from "./task-card";
import { TaskEditor, type Status, type Task, type TaskChange, type TaskNote } from "./task-editor";
import { Kanban, useLanes } from "./task-kanban";
import { TaskTimeline, type Zoom } from "./task-timeline";
import { Avatar, DueChip, Icon, Menu, StatusChip, type IconName } from "./ui";
import type { Project } from "./workspace";

export { Assignee, todayInSeoul };

type Counts = Record<Status, number>;
type Summary = components["schemas"]["TaskSummary"];
type TaskSelection = { task?: Task; change?: TaskChange };
export type TaskView = "board" | "list" | "timeline";
const pageSize = 100;
const views: [TaskView, string, IconName][] = [["board", "보드", "board"], ["list", "목록", "list"], ["timeline", "타임라인", "timeline"]];

/** Filters and view options that are safe to keep in the URL and pass between the board, list and detail. */
export function taskFilters(query: URLSearchParams) {
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
  if (view && views.some(([value]) => value === view)) params.set("view", view);
  const group = query.get("group");
  if (group === "assignee" && view !== "list" && view !== "timeline") params.set("group", group);
  if (group === "status" && view === "timeline") params.set("group", group);
  if (view === "timeline" && query.get("zoom") === "month") params.set("zoom", "month");
  const start = query.get("start");
  if (view === "timeline" && start && /^\d{4}-\d{2}-\d{2}$/.test(start)) params.set("start", start);
  return params;
}

export function TaskBoard({ project, initialNote, revision: external = 0 }: { project: Project; initialNote?: string; revision?: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const query = useSearchParams();
  const filters = taskFilters(new URLSearchParams(query));
  const requestedView = filters.get("view");
  const view: TaskView = requestedView === "list" || requestedView === "timeline" ? requestedView : "board";
  const group = view === "board" && filters.get("group") === "assignee" ? "assignee" : "";
  const listPath = pathname.replace(/\/tasks\/[^/]+$/, "/tasks");
  const [input, setInput] = useState(filters.get("q") ?? "");
  const [selection, setSelection] = useState<TaskSelection>();
  const [seedNote, setSeedNote] = useState<TaskNote>();
  const [error, setError] = useState("");
  const [counts, setCounts] = useState<Counts>();
  const [summary, setSummary] = useState<Summary>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string>();
  const base = "/v1/projects/" + project.id;
  const { members, error: memberError } = useProjectMembers(project.id);
  const canWrite = project.role !== "reviewer" && !project.archived_at;
  const detailQuery = filters.size ? "?" + filters : "";
  const apiFilters = new URLSearchParams(filters);
  for (const name of ["view", "group", "zoom", "start"]) apiFilters.delete(name);
  if (!apiFilters.has("archived")) apiFilters.set("archived", "false");
  const queryString = apiFilters.toString();
  const refresh = revision + external;
  const visible = statuses.map(([value]) => value).filter((value) => !filters.get("status") || filters.get("status") === value);
  const { lanes, loadMore } = useLanes(base, queryString, view === "board" ? visible : [], refresh);

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
    Promise.all([
      api<Counts>(base + "/task-counts?" + queryString, { signal: request.signal }),
      api<Summary>(base + "/task-summary?" + queryString, { signal: request.signal }),
    ]).then(([nextCounts, nextSummary]) => {
      if (request.signal.aborted) return;
      setCounts(nextCounts);
      setSummary(nextSummary);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [base, queryString, refresh]);

  function href(changes: Record<string, string>) {
    const params = new URLSearchParams(filters);
    for (const [name, value] of Object.entries(changes)) {
      if (value) params.set(name, value);
      else params.delete(name);
    }
    return listPath + (params.size ? "?" + params : "");
  }

  function close() {
    setSelection(undefined);
    setSeedNote(undefined);
    if (initialNote) router.replace(listPath + detailQuery);
  }

  async function move(task: Task, change: TaskUpdate) {
    setBusy(task.id);
    setError("");
    try {
      const result = await moveTask(base, task.id, change);
      if (result.saved) setRevision((value) => value + 1);
      else setSelection({ task: result.task, change });
    } catch (cause) {
      setError(describeError(cause));
      setRevision((value) => value + 1);
    } finally {
      setBusy(undefined);
    }
  }

  async function create(title: string, status: Status, assignee: string) {
    setError("");
    try {
      const filtered = filters.get("assignee");
      await createTask(base, { title, status, assignee_id: assignee || (filtered && filtered !== "unassigned" ? filtered : "") });
      setRevision((value) => value + 1);
      return true;
    } catch (cause) {
      setError(describeError(cause));
      return false;
    }
  }

  const filtered = ["q", "status", "assignee", "due", "archived"].some((name) => filters.has(name));
  return <section id="task-board" aria-label="작업">
    <div className="row spread wrap section-header">
      <div className="row wrap">
        <h2 className="section-title">작업</h2>
        <nav className="segmented view-switch" aria-label="작업 보기">
          {views.map(([value, label, icon]) => <Link key={value} className="button" href={href({ view: value === "board" ? "" : value, group: "", zoom: "", start: "" })}
            aria-current={view === value ? "page" : undefined}><Icon name={icon} />{label}</Link>)}
        </nav>
      </div>
      {canWrite && <button className="primary" onClick={() => setSelection({})}><Icon name="plus" />새 작업</button>}
    </div>
    <TaskSummaryStrip counts={counts} summary={summary} members={members} filters={filters} href={href} />
    <div className="row wrap task-toolbar">
      <form className="row search-field" role="search" onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        router.push(href({ q: input.trim() }));
      }}>
        <input type="search" aria-label="작업 검색" placeholder="작업 검색" maxLength={200} value={input} onChange={(event) => setInput(event.target.value)} />
        <button>검색</button>
      </form>
      <label>상태 <select value={filters.get("status") ?? ""} onChange={(event) => router.push(href({ status: event.target.value }))}>
        <option value="">전체</option>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>담당자 <select value={filters.get("assignee") ?? ""} onChange={(event) => router.push(href({ assignee: event.target.value }))}>
        <option value="">전체</option><option value="unassigned">미할당</option>
        {members.map((member) => <option key={member.account_id} value={member.account_id}>{displayName(member)}</option>)}
      </select></label>
      <label>마감 <select value={filters.get("due") ?? ""} onChange={(event) => router.push(href({ due: event.target.value }))}>
        <option value="">전체</option><option value="soon">7일 내</option><option value="late">지연</option><option value="none">마감 없음</option>
      </select></label>
      {view === "board" && <label>묶기 <select value={group} onChange={(event) => router.push(href({ group: event.target.value }))}>
        <option value="">없음</option><option value="assignee">담당자</option>
      </select></label>}
      {view === "timeline" && <label>묶기 <select value={filters.get("group") === "status" ? "status" : ""} onChange={(event) => router.push(href({ group: event.target.value }))}>
        <option value="">담당자</option><option value="status">상태</option>
      </select></label>}
      <label className="row"><input type="checkbox" checked={filters.get("archived") === "true"}
        onChange={(event) => router.push(href({ archived: event.target.checked ? "true" : "" }))} />보관된 작업</label>
      {filtered && <Link href={href({ q: "", status: "", assignee: "", due: "", archived: "" })}>필터 초기화</Link>}
    </div>
    {(error || memberError) && <p role="alert" className="error">{error || memberError}</p>}
    {view === "timeline" ? <TaskTimeline base={base} projectId={project.id} members={members} canWrite={canWrite} apiQuery={queryString}
      detailQuery={detailQuery} group={filters.get("group") === "status" ? "status" : "assignee"} zoom={(filters.get("zoom") ?? "week") as Zoom}
      start={filters.get("start") ?? undefined} refresh={refresh} onMove={(task, change) => move(task, change)} />
    : view === "board" ? <Kanban projectId={project.id} lanes={lanes} counts={counts} visible={visible} members={members} canWrite={canWrite}
      group={group} detailQuery={detailQuery} busy={busy} onMove={(task, change) => void move(task, change)}
      onCreate={create} onArchive={(task) => void move(task, { archived: !task.archived })} loadMore={(status) => void loadMore(status)} />
      : <div className="task-list">
        <div className="task-list-row task-list-head" aria-hidden="true"><span>작업</span><span>상태</span><span>담당자</span><span>마감</span><span>피드백</span><span /></div>
        <TaskRows key={queryString + ":" + refresh} path={base + "/tasks?" + queryString} render={(task) =>
          <TaskListRow task={task} projectId={project.id} members={members} href={taskHref(project.id, task.id) + detailQuery}
            menu={canWrite && <Menu className="task-menu" buttonLabel={task.title + " 관리"} buttonClassName="icon-button" label={<Icon name="more" />}>
              {(closeMenu) => <div className="menu-list">
                {!task.archived && statuses.filter(([value]) => value !== task.status).map(([value, label]) => <button type="button" className="menu-item" key={value}
                  onClick={() => { closeMenu(); void move(task, { status: value }); }}><span className={"status-dot status-" + value} aria-hidden="true" />{label}으로 이동</button>)}
                <button type="button" className="menu-item" onClick={() => { closeMenu(); void move(task, { archived: !task.archived }); }}>{task.archived ? "복원" : "보관"}</button>
              </div>}
            </Menu>} />} />
      </div>}
    {selection && canWrite && <TaskEditor base={base} members={members} task={selection.task} seedNote={seedNote} change={selection.change}
      close={close} saved={(id) => {
        close();
        setRevision((value) => value + 1);
        if (!selection.task) router.push(taskHref(project.id, id) + detailQuery);
      }} />}
  </section>;
}

function TaskSummaryStrip({ counts, summary, members, filters, href }: {
  counts?: Counts; summary?: Summary; members: ReturnType<typeof useProjectMembers>["members"];
  filters: URLSearchParams; href: (changes: Record<string, string>) => string;
}) {
  if (!counts || !summary) return <div className="summary-strip" aria-busy="true" />;
  const total = statuses.reduce((sum, [value]) => sum + counts[value], 0);
  const assignee = filters.get("assignee");
  return <div className="summary-strip">
    <div className="summary-progress">
      <div className="progress-bar" role="img" aria-label={"완료 " + counts.done + " / 전체 " + total}>
        {statuses.map(([value]) => counts[value] > 0 && <span key={value} className={"progress-" + value} style={{ flexGrow: counts[value] }} />)}
      </div>
      <ul className="summary-counts">
        {statuses.map(([value, label]) => <li key={value}><span className={"status-dot status-" + value} aria-hidden="true" />{label}<strong>{counts[value]}</strong></li>)}
      </ul>
    </div>
    <div className="summary-people" aria-label="담당자별 진행 중 작업">
      {summary.assignees.filter(({ open }) => open > 0).map((load) => {
        const member = members.find(({ account_id }) => account_id === load.assignee_id);
        const key = load.assignee_id || "unassigned";
        const label = (member ? displayName(member) : load.assignee_id ? "이전 팀원" : "미할당") + " 진행 중 " + load.open + "개" + (load.late ? ", 지연 " + load.late + "개" : "");
        return <Link key={key} className="load-chip" href={href({ assignee: assignee === key ? "" : key })} aria-current={assignee === key ? "true" : undefined} aria-label={label} title={label}>
          {member ? <Avatar id={member.account_id} person={member} size="sm" /> : <span className="avatar avatar-sm avatar-empty" aria-hidden="true" />}
          <span>{load.open}</span>{load.late > 0 && <span className="load-late">{load.late}</span>}
        </Link>;
      })}
      {summary.late > 0 && <Link className="late-link" href={href({ due: filters.get("due") === "late" ? "" : "late" })}><Icon name="alert" size={14} />지연 {summary.late}</Link>}
    </div>
  </div>;
}

function TaskListRow({ task, projectId, members, href, menu }: { task: Task; projectId: string; members: Parameters<typeof Assignee>[0]["members"]; href: string; menu?: ReactNode }) {
  return <article className="task-list-row">
    <span className="task-list-title">
      <Link href={href} className="resource-title">{task.title}</Link>
      {task.source && <SourceChip projectId={projectId} source={task.source} />}
    </span>
    <StatusChip status={task.status} suffix={task.archived ? " · 보관됨" : ""} />
    <Assignee members={members} id={task.assignee_id} />
    <DueChip due={task.due_on} status={task.status} empty="마감 없음" />
    <span><FeedbackCount count={task.notes.length} /></span>
    <span>{menu}</span>
  </article>;
}

function TaskRows({ path, render }: { path: string; render: (task: Task) => ReactNode }) {
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
      {rows.map((task) => <li key={task.id}>{render(task)}</li>)}
    </ul>}
    {more && <button disabled={loading} onClick={() => void loadMore()}>작업 더 보기</button>}
  </>;
}
