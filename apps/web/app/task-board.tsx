"use client";

import { Badge, Button, Checkbox, Menu, NativeSelect, Select, TextInput } from "@mantine/core";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, describeError } from "../lib/api";
import { todayInSeoul } from "../lib/task-dates";
import { displayName } from "../lib/people";
import type { components } from "../lib/api-types";
import { projectHref, taskHref, versionHref, versionLink } from "../lib/routes";
import { TaskEditor, statuses, statusLabel, type Status, type Task, type TaskChange, type TaskNote } from "./task-editor";
import { timecode } from "../lib/timecode";
import type { Member, Project } from "./workspace";
import { ActionMenu } from "./action-menu";
import { TaskStatusBadge } from "./task-status-badge";
import { TaskTimeline } from "./task-timeline";
import { DraggableTask, TaskLane, type TaskMove } from "./task-drag";
import { EmptyState, InlineError, LoadingRows } from "./request-states";

type Counts = Record<Status, number>;
type TaskSummary = components["schemas"]["TaskSummary"];
type TaskSelection = { task?: Task; change?: TaskChange; returnFocusTo?: HTMLButtonElement | null };
const pageSize = 100;

function taskFilters(query: URLSearchParams) {
  const params = new URLSearchParams();
  const search = query.get("q");
  const status = query.get("status");
  const assignee = query.get("assignee");
  const due = query.get("due");
  const view = query.get("view");
  if (query.get("group") === "assignee") params.set("group", "assignee");
  if (search) params.set("q", search.slice(0, 200));
  if (status && statuses.some(([value]) => value === status)) params.set("status", status);
  if (assignee && (assignee === "unassigned" || /^[0-9a-f-]{36}$/.test(assignee))) params.set("assignee", assignee);
  if (due && ["late", "soon", "none"].includes(due)) params.set("due", due);
  if (query.get("archived") === "true") params.set("archived", "true");
  if (view === "board" || view === "list" || view === "timeline") params.set("view", view);
  if (view === "timeline") {
    const start = query.get("start");
    if (start && /^\d{4}-\d{2}-\d{2}$/.test(start) && Number.isFinite(Date.parse(start)) &&
      new Date(start).toISOString().slice(0, 10) === start) params.set("start", start);
    if (query.get("zoom") === "month") params.set("zoom", "month");
  }
  return params;
}

function useMembers(base: string) {
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const request = new AbortController();

    api<Member[]>(base + "/members", { signal: request.signal }).then((rows) => {
      if (!request.signal.aborted) setMembers(rows);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [base]);
  return { members, error };
}

export function TaskBoard({ project, initialNote }: { project: Project; initialNote?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const query = useSearchParams();
  const filters = taskFilters(new URLSearchParams(query));
  const timeline = filters.get("view") === "timeline";
  const board = !timeline && filters.get("view") !== "list";
  const groupByAssignee = filters.get("group") === "assignee";
  const [input, setInput] = useState(filters.get("q") ?? "");
  const [selection, setSelection] = useState<TaskSelection>();
  const [seedNote, setSeedNote] = useState<TaskNote>();
  const [error, setError] = useState("");
  const [counts, setCounts] = useState<Counts>();
  const [summary, setSummary] = useState<TaskSummary>();
  const [revision, setRevision] = useState(0);
  const moveLockRef = useRef(false);
  const [moving, setMoving] = useState(false);
  const [moveNotice, setMoveNotice] = useState("");
  const base = "/v1/projects/" + project.id;
  const { members, error: memberError } = useMembers(base);
  const canWrite = project.role !== "reviewer" && !project.archived_at;
  const detailQuery = filters.size ? "?" + filters : "";
  const apiFilters = new URLSearchParams(filters);
  apiFilters.delete("view");
  apiFilters.delete("group");
  apiFilters.delete("start");
  apiFilters.delete("zoom");
  if (!apiFilters.has("archived")) apiFilters.set("archived", "false");
  const queryString = apiFilters.toString();

  const moveTask = useCallback(({ task, status, position }: TaskMove, returnFocusTo?: HTMLButtonElement | null) => {
    if (!canWrite || task.archived || moveLockRef.current) return;
    if (task.status !== status && (status === "review" || status === "done")) {
      setSelection({ task, change: { status, position }, returnFocusTo });
      return;
    }

    moveLockRef.current = true;
    setMoving(true);
    setError("");
    setMoveNotice("");
    void api(base + "/tasks/" + task.id, {
      method: "PUT",
      body: JSON.stringify({
        title: task.title, description: task.description, status, position,
        assignee_id: task.assignee_id, due_on: task.due_on, start_on: task.start_on, result_version_id: task.result_version_id,
        review_text: task.review_text, archived: task.archived, revision: task.revision,
        note_ids: task.notes.map(({ id }) => id), confirm_notes: [],
      }),
    }).then(() => {
      setMoveNotice(task.title + " · " + statusLabel(status) + "으로 이동했습니다.");
      setRevision((value) => value + 1);
    }).catch((cause) => {
      setError(describeError(cause));
      setRevision((value) => value + 1);
    }).finally(() => {
      moveLockRef.current = false;
      setMoving(false);
    });
  }, [base, canWrite, setRevision]);

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
      api<TaskSummary>(base + "/task-summary?" + queryString, { signal: request.signal }),
    ]).then(([counts, summary]) => {
      if (request.signal.aborted) return;
      setCounts(counts);
      setSummary(summary);
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

  async function scheduleTask(task: Task, dates: { start_on: string; due_on: string }) {
    if (!canWrite || task.archived || moveLockRef.current) return;

    moveLockRef.current = true;
    setMoving(true);
    setError("");
    setMoveNotice("");
    try {
      await api(base + "/tasks/" + task.id, {
        method: "PUT",
        body: JSON.stringify({
          title: task.title, description: task.description, status: task.status, assignee_id: task.assignee_id,
          result_version_id: task.result_version_id, review_text: task.review_text, archived: task.archived,
          revision: task.revision, note_ids: task.notes.map(({ id }) => id),
          confirm_notes: task.status === "done" ? task.notes.filter((note) => !note.resolved && !note.deleted)
            .map(({ id, revision }) => ({ id, revision })) : [],
          ...dates,
        }),
      });
      setMoveNotice(task.title + " · 일정을 저장했습니다.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      moveLockRef.current = false;
      setMoving(false);
      setRevision((value) => value + 1);
    }
  }

  function taskCard(task: Task, previous?: Task) {
    const link = taskHref(project.id, task.id) + detailQuery;
    const assignee = members.find(({ account_id }) => account_id === task.assignee_id);
    const late = task.due_on && task.status !== "done" && task.due_on < todayInSeoul();

    const content = <>
      <Link href={link} className="resource-title">{task.title}</Link>
      {!board && <TaskStatusBadge status={task.status} />}
      <span className="muted">{assignee ? displayName(assignee) : "미할당"}</span>
      <span className={late ? "error" : "muted"}>{task.due_on || "마감 없음"}{late ? " · 지연" : ""}</span>
      {task.source && <Link className="task-source-link" href={versionHref({
        projectId: project.id, itemId: task.source.item_id, versionId: task.source.version_id,
        noteId: task.source.note_id, at: task.source.start_ms,
      })}>{task.source.item_title} · {timecode(task.source.start_ms)}</Link>}
      <span className="muted">피드백 {task.notes.length}</span>
      {canWrite && <ActionMenu label="더 보기" accessibleName={task.title + " 관리"}>{(trigger) => <>
        {!task.archived && previous && (
          <Menu.Item disabled={moving} onClick={() => moveTask({ task, status: task.status, position: previous.position })}>
            위로 이동
          </Menu.Item>
        )}
        {!task.archived && statuses.filter(([value]) => value !== task.status).map(([value, label]) => (
          <Menu.Item key={value} disabled={moving} onClick={() => moveTask({ task, status: value }, trigger.current)}>
            {label}으로 이동
          </Menu.Item>
        ))}
        <Menu.Item onClick={() => setSelection({ task, change: { archived: !task.archived }, returnFocusTo: trigger.current })}>
          {task.archived ? "복원" : "보관"}
        </Menu.Item>
      </>}</ActionMenu>}
    </>;

    return board ? <DraggableTask projectId={project.id} task={task} enabled={canWrite && !moving && !task.archived} onMove={moveTask}>{content}</DraggableTask>
      : <article className="task-list-row">{content}</article>;
  }

  return <section id="task-board" aria-label="작업">
    <div className="row spread wrap section-header">
      <h2 className="section-title">작업</h2>
      {canWrite && <Button onClick={(event) => setSelection({ returnFocusTo: event.currentTarget })}>새 작업</Button>}
    </div>
    <div className="row wrap">
      <div className="segmented" aria-label="작업 보기">
        <Button component={Link} variant="default" href={href("view", "list")} aria-current={!board && !timeline ? "page" : undefined}>목록</Button>
        <Button component={Link} variant="default" href={href("view", "")} aria-current={board ? "page" : undefined}>보드</Button>
        <Button component={Link} variant="default" href={href("view", "timeline")} aria-current={timeline ? "page" : undefined}>타임라인</Button>
      </div>
      <form className="row wrap" onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        router.push(href("q", input.trim()));
      }}>
        <TextInput type="search" aria-label="작업 검색" placeholder="작업 검색" maxLength={200} value={input} onChange={(event) => setInput(event.currentTarget.value)} />
        <Button type="submit" variant="default">검색</Button>
      </form>
    </div>
    <div className="row wrap filter-bar">
      <NativeSelect label="상태" value={filters.get("status") ?? ""}
        data={[{ value: "", label: "전체" }, ...statuses.map(([value, label]) => ({ value, label }))]}
        onChange={(event) => router.push(href("status", event.currentTarget.value))} />
      <Select label="담당자" searchable clearable placeholder="전체" value={filters.get("assignee")}
        data={[{ value: "unassigned", label: "미할당" }, ...members.map(({ account_id, email }) => ({ value: account_id, label: email }))]}
        onChange={(value) => router.push(href("assignee", value ?? ""))} />
      <NativeSelect label="마감" value={filters.get("due") ?? ""}
        data={[{ value: "", label: "전체" }, { value: "soon", label: "7일 내" }, { value: "late", label: "지연" }, { value: "none", label: "마감 없음" }]}
        onChange={(event) => router.push(href("due", event.currentTarget.value))} />
      <Checkbox label="보관된 작업" checked={filters.get("archived") === "true"}
        onChange={(event) => router.push(href("archived", event.currentTarget.checked ? "true" : ""))} />
      {(board || timeline) && <Checkbox label="담당자별 그룹" checked={groupByAssignee}
        onChange={(event) => router.push(href("group", event.currentTarget.checked ? "assignee" : ""))} />}
      {filters.size > Number(filters.has("view")) && <Link href={pathname + (timeline ? "?view=timeline" : board ? "" : "?view=list")}>필터 초기화</Link>}
    </div>
    {summary && <div className="row wrap task-summary" aria-label="작업 요약">
      <span>미완료 {summary.open}건 · 지연 {summary.late}건</span>
      {groupByAssignee && summary.assignees.map((load) => {
        const member = members.find(({ account_id }) => account_id === load.assignee_id);
        const label = member ? displayName(member) : load.assignee_id ? "이전 담당자" : "미할당";
        return <Badge key={load.assignee_id} variant="light" tt="none">{label} · 미완료 {load.open} · 지연 {load.late}</Badge>;
      })}
    </div>}
    {(error || memberError) && <InlineError message={error || memberError} />}
    <p role="status" className="muted">{moving ? "작업을 이동하는 중" : moveNotice || (board && canWrite ? "카드를 끌어 순서를 바꾸거나 다른 상태로 옮기세요. 더 보기 메뉴로도 이동할 수 있습니다." : "")}</p>
    {timeline ? <TaskTimeline base={base} projectId={project.id} members={members} canWrite={canWrite && !moving}
      apiQuery={queryString} detailQuery={detailQuery} group={groupByAssignee ? "assignee" : "status"}
      zoom={filters.get("zoom") === "month" ? "month" : "week"} start={filters.get("start") ?? undefined}
      refresh={revision} onMove={scheduleTask} /> : board ? <div className="board" aria-busy={moving}>
      {statuses.filter(([value]) => !filters.get("status") || filters.get("status") === value).map(([value, label]) => {
        const lane = new URLSearchParams(queryString);
        lane.set("status", value);
        return <TaskLane key={value} projectId={project.id} status={value} label={label} enabled={canWrite && !moving} onMove={moveTask}>
          <h3><TaskStatusBadge status={value} /> {counts && <span className="muted">{counts[value]}</span>}</h3>
          {canWrite && !filters.has("archived") && (value === "todo" || value === "progress") &&
            <QuickTask base={base} status={value} assignee={filters.get("assignee")}
              saved={() => setRevision((value) => value + 1)} />}
          <TaskRows key={lane.toString() + ":" + revision} path={base + "/tasks?" + lane} render={taskCard}
            groupLabel={groupByAssignee ? (assignee) => {
              const member = members.find(({ account_id }) => account_id === assignee);
              return member ? displayName(member) : assignee ? "이전 담당자" : "미할당";
            } : undefined} />
        </TaskLane>;
      })}
    </div> : <div className="task-list">
      <TaskRows key={queryString + ":" + revision} path={base + "/tasks?" + queryString} render={taskCard} />
    </div>}
    {selection && canWrite && <TaskEditor base={base} members={members} task={selection.task} seedNote={seedNote} change={selection.change} returnFocusTo={selection.returnFocusTo}
      close={close} saved={(id) => {
        close();
        setRevision((value) => value + 1);
        if (!selection.task) openDetail(id);
      }} />}
  </section>;
}

function QuickTask({ base, status, assignee, saved }: {
  base: string; status: "todo" | "progress"; assignee: string | null; saved: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);

  function close() {
    setAdding(false);
    setTitle("");
    setError("");
    trigger.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || saving) return;

    setSaving(true);
    setError("");
    try {
      await api(base + "/tasks", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), status, assignee_id: assignee === "unassigned" ? "" : assignee ?? "" }),
      });
      close();
      saved();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return <>
    <Button ref={trigger} type="button" variant="subtle" size="compact-sm" aria-expanded={adding}
      onClick={() => { if (adding) close(); else setAdding(true); }} disabled={saving}>빠른 추가</Button>
    {adding && <form className="task-quick-form" onSubmit={submit}>
      <TextInput label="작업 제목" autoFocus required maxLength={160} value={title}
        onChange={(event) => setTitle(event.currentTarget.value)} />
      {error && <InlineError message={error} />}
      <div className="row">
        <Button type="submit" size="compact-sm" loading={saving}>추가</Button>
        <Button type="button" size="compact-sm" variant="default" disabled={saving} onClick={close}>취소</Button>
      </div>
    </form>}
  </>;
}

function TaskRows({ path, render, groupLabel }: {
  path: string;
  render: (task: Task, previous?: Task) => ReactNode;
  groupLabel?: (assignee: string) => string;
}) {
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

  const groups = new Map<string, Task[]>();
  for (const task of rows ?? []) {
    const group = groupLabel ? task.assignee_id : "";
    const tasks = groups.get(group);
    if (tasks) tasks.push(task);
    else groups.set(group, [task]);
  }

  return <>
    {error && <InlineError message={error} retry={() => { setError(""); setAttempt((value) => value + 1); }} />}
    {!rows && !error && <LoadingRows label="작업을 불러오는 중" />}
    {rows?.length === 0 && <EmptyState message="표시할 작업이 없습니다." />}
    {[...groups].map(([assignee, tasks]) => <div className="task-row-group" key={assignee}>
      {groupLabel && <h4>{groupLabel(assignee)}</h4>}
      <ul className="task-rows">
        {tasks.map((task, index) => {
          const previous = tasks[index - 1];
          return <li key={task.id}>{render(task, previous?.status === task.status ? previous : undefined)}</li>;
        })}
      </ul>
    </div>)}
    {more && <button disabled={loading} onClick={() => void loadMore()}>작업 더 보기</button>}
  </>;
}

export function TaskDetail({ project, taskId }: { project: Project; taskId: string }) {
  const base = "/v1/projects/" + project.id;
  const { members, error: memberError } = useMembers(base);
  const params = taskFilters(new URLSearchParams(useSearchParams()));
  const [task, setTask] = useState<Task>();
  const [selection, setSelection] = useState<TaskSelection>();
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
  const assignee = members.find(({ account_id }) => account_id === task?.assignee_id);

  return <section aria-label="작업 상세">
    <Link href={back}>작업 목록</Link>
    {(error || memberError) && <InlineError message={error || memberError}
      retry={() => { setError(""); setRevision((value) => value + 1); }} />}
    {!task && !error && <LoadingRows label="작업을 불러오는 중" />}
    {task && <>
      <div className="row spread wrap section-header task-detail-title">
        <h2 className="section-title">{task.title}</h2>
        {canWrite && <div className="row wrap">
          {!task.archived && nextStatus && <button className="primary" onClick={(event) => setSelection({ change: { status: nextStatus }, returnFocusTo: event.currentTarget })}>{nextLabel}</button>}
          {!task.archived && <button onClick={(event) => setSelection({ returnFocusTo: event.currentTarget })}>작업 편집</button>}
          <ActionMenu label="관리">{(trigger) => (
            <Menu.Item onClick={() => setSelection({ change: { archived: !task.archived }, returnFocusTo: trigger.current })}>
              {task.archived ? "작업 복원" : "작업 보관"}
            </Menu.Item>
          )}</ActionMenu>
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
              {note.resolved && <Badge variant="light" color="teal" tt="none">해결됨</Badge>}
            </li>)}
          </ul>
          {(task.result_version_id || task.review_text) && <section>
            <h3>검토 결과</h3>
            {task.result_version_id && <Link href={versionLink(project.id, task.result_version_id)}>결과 버전 열기</Link>}
            {task.review_text && <p className="message-body">{task.review_text}</p>}
          </section>}
        </div>
        <dl className="task-metadata">
          <dt>상태</dt><dd><div className="row wrap"><TaskStatusBadge status={task.status} />{task.archived && <Badge variant="light" color="gray" tt="none">보관됨</Badge>}</div></dd>
          <dt>담당자</dt><dd>{assignee ? displayName(assignee) : "미할당"}</dd>
          <dt>시작일</dt><dd>{task.start_on || "시작일 없음"}</dd>
          <dt>마감일</dt><dd>{task.due_on || "마감 없음"}</dd>
        </dl>
      </div>
      {selection && canWrite && <TaskEditor base={base} members={members} task={task} change={selection.change}
        returnFocusTo={selection.returnFocusTo} close={() => setSelection(undefined)} saved={() => {
          setSelection(undefined);
          setRevision((value) => value + 1);
        }} />}
    </>}
  </section>;
}
