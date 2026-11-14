"use client";

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import { taskHref } from "../lib/routes";
import { statuses } from "../lib/tasks";
import type { Status, Task, TaskChange } from "./task-editor";
import { TaskCardBody } from "./task-card";
import { Icon, Menu, Person, Unassigned } from "./ui";
import type { Member } from "./workspace";

const pageSize = 100;
type Lane = { rows?: Task[]; more: boolean; error: string };
type Drag = { id: string; status: Status; assignee: string };
type Target = { cell: string; index: number };

/** Loads one page per status lane for the current filters and keeps showing the last result while reloading. */
export function useLanes(base: string, query: string, visible: Status[], revision: number) {
  const [lanes, setLanes] = useState<Partial<Record<Status, Lane>>>({});
  const [attempt, setAttempt] = useState(0);
  const statusKey = visible.join(",");

  useEffect(() => {
    const request = new AbortController();
    void Promise.all(statusKey.split(",").map(async (status) => {
      const params = new URLSearchParams(query);
      params.set("status", status);
      try {
        const rows = await api<Task[]>(base + "/tasks?" + params, { signal: request.signal });
        return [status, { rows, more: rows.length === pageSize, error: "" }] as const;
      } catch (cause) {
        return [status, { more: false, error: describeError(cause) }] as const;
      }
    })).then((entries) => {
      if (!request.signal.aborted) setLanes(Object.fromEntries(entries));
    });
    return () => request.abort();
  }, [attempt, base, query, revision, statusKey]);

  async function loadMore(status: Status) {
    const lane = lanes[status];
    const cursor = lane?.rows?.at(-1)?.id;
    if (!cursor) return;
    const params = new URLSearchParams(query);
    params.set("status", status);
    params.set("after", cursor);
    try {
      const next = await api<Task[]>(base + "/tasks?" + params);
      setLanes((previous) => ({
        ...previous,
        [status]: { rows: [...(previous[status]?.rows ?? []), ...next.filter(({ id }) => !previous[status]?.rows?.some((row) => row.id === id))], more: next.length === pageSize, error: "" },
      }));
    } catch (cause) {
      setLanes((previous) => ({ ...previous, [status]: { ...previous[status], more: true, error: describeError(cause) } }));
    }
  }

  return { lanes, loadMore, retry: () => setAttempt((value) => value + 1) };
}

export function Kanban({ projectId, lanes, counts, visible, members, canWrite, group, detailQuery, busy, onMove, onCreate, onArchive, loadMore }: {
  projectId: string;
  counts?: Record<Status, number>;
  lanes: Partial<Record<Status, Lane>>;
  visible: Status[];
  members: Member[];
  canWrite: boolean;
  group: "" | "assignee";
  detailQuery: string;
  busy?: string;
  onMove: (task: Task, change: TaskChange) => void;
  onCreate: (title: string, status: Status, assignee: string) => Promise<boolean>;
  onArchive: (task: Task) => void;
  loadMore: (status: Status) => void;
}) {
  const [drag, setDrag] = useState<Drag>();
  const [target, setTarget] = useState<Target>();
  const assignable = members.filter(({ role }) => role !== "reviewer");
  const known = new Set(assignable.map(({ account_id }) => account_id));
  const strangers = new Set<string>();
  for (const status of visible) for (const task of lanes[status]?.rows ?? []) {
    if (task.assignee_id && !known.has(task.assignee_id)) strangers.add(task.assignee_id);
  }
  const groups: { key: string; assignee: string }[] = group === "assignee"
    ? [...assignable.map(({ account_id }) => ({ key: account_id, assignee: account_id })),
      ...[...strangers].map((id) => ({ key: id, assignee: id })), { key: "unassigned", assignee: "" }]
    : [{ key: "all", assignee: "*" }];

  function rowsFor(status: Status, assignee: string) {
    const rows = lanes[status]?.rows ?? [];
    return assignee === "*" ? rows : rows.filter((task) => (task.assignee_id || "") === assignee);
  }

  function place(rows: Task[], task: Task, index: number, status: Status, assignee: string) {
    const others = rows.filter(({ id }) => id !== task.id);
    const original = rows.findIndex(({ id }) => id === task.id);
    if (original === index && task.status === status) return;
    const before = others[index];
    const position = before ? before.position : (others.at(-1)?.position ?? -1) + 1;
    onMove(task, { status, position, ...(assignee !== "*" && assignee !== (task.assignee_id || "") ? { assignee_id: assignee } : {}) });
  }

  function find(id: string) {
    for (const status of visible) {
      const task = lanes[status]?.rows?.find((row) => row.id === id);
      if (task) return task;
    }
  }

  const board = (assignee: string, key: string) => <div className="board" role={group ? "group" : undefined}>
    {visible.map((status) => {
      const [, label] = statuses.find(([value]) => value === status)!;
      const lane = lanes[status];
      const rows = rowsFor(status, assignee);
      const cell = key + ":" + status;
      const indicator = target?.cell === cell ? target.index : undefined;
      const others = drag ? rows.filter(({ id }) => id !== drag.id) : rows;

      function indexAt(event: DragEvent<HTMLElement>, id: string) {
        const cards = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-task-id]")].filter((element) => element.dataset.taskId !== id);
        const index = cards.findIndex((element) => {
          const box = element.getBoundingClientRect();
          return event.clientY < box.top + box.height / 2;
        });
        return index < 0 ? cards.length : index;
      }

      function over(event: DragEvent<HTMLElement>) {
        if (!drag) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const index = indexAt(event, drag.id);
        if (target?.cell !== cell || target.index !== index) setTarget({ cell, index });
      }

      return <section className={"lane lane-" + status + (indicator !== undefined ? " lane-target" : "")} key={status} aria-label={label}
        onDragOver={canWrite ? over : undefined}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && !event.currentTarget.contains(next) && target?.cell === cell) setTarget(undefined);
        }}
        onDrop={canWrite ? (event) => {
          event.preventDefault();
          const id = drag?.id ?? event.dataTransfer.getData("text/plain");
          const task = id ? find(id) : undefined;
          if (task) place(rows, task, indexAt(event, task.id), status, assignee);
          setDrag(undefined);
          setTarget(undefined);
        } : undefined}>
        <h3 className="lane-title"><span className={"status-dot status-" + status} aria-hidden="true" />{label}
          <span className="lane-count">{group || !counts ? rows.length : counts[status]}<span className="visually-hidden">개</span></span></h3>
        {lane?.error && <p role="alert" className="error small">{lane.error}</p>}
        {!lane && <p role="status" className="muted small">작업을 불러오는 중</p>}
        <ol className="lane-cards">
          {rows.map((task) => {
            const index = others.findIndex(({ id }) => id === task.id);
            const position = rows.findIndex(({ id }) => id === task.id);
            return <li key={task.id} className="lane-slot">
              {indicator !== undefined && index === indicator && <div className="drop-indicator" aria-hidden="true" />}
              <TaskCard task={task} projectId={projectId} members={members} detailQuery={detailQuery}
                canWrite={canWrite} saving={busy === task.id} dragging={drag?.id === task.id}
                previous={rows[position - 1]} next={rows[position + 1]}
                onDragStart={() => setDrag({ id: task.id, status, assignee: task.assignee_id || "" })}
                onDragEnd={() => { setDrag(undefined); setTarget(undefined); }}
                onMove={(change) => onMove(task, change)} onArchive={() => onArchive(task)} />
            </li>;
          })}
          {indicator !== undefined && indicator >= others.length && <li className="lane-slot"><div className="drop-indicator" aria-hidden="true" /></li>}
        </ol>
        {lane?.rows && rows.length === 0 && indicator === undefined && <p className="lane-empty">{drag ? "여기에 놓기" : "작업 없음"}</p>}
        {lane?.more && !group && <button className="small-button" onClick={() => loadMore(status)}>더 보기</button>}
        {canWrite && (status === "todo" || status === "progress") &&
          <QuickAdd label={label} create={(title) => onCreate(title, status, assignee === "*" ? "" : assignee)} />}
      </section>;
    })}
  </div>;

  if (group !== "assignee") return board("*", "all");

  return <div className="swimlanes">
    {groups.map(({ key, assignee }) => {
      const member = members.find(({ account_id }) => account_id === assignee);
      const count = visible.reduce((total, status) => total + rowsFor(status, assignee).filter((task) => task.status !== "done").length, 0);
      return <section className="swimlane" key={key} aria-label={(member ? member.name || member.email : assignee ? "이전 팀원" : "미할당") + " 작업"}>
        <h3 className="swimlane-title">{member ? <Person id={member.account_id} person={member} size="md" /> : <Unassigned />}
          <span className="lane-count">진행 {count}</span></h3>
        {board(assignee, key)}
      </section>;
    })}
    {visible.some((status) => lanes[status]?.more) && <p className="muted small">각 상태의 처음 {pageSize}개 작업을 담당자별로 나눠 표시합니다.</p>}
  </div>;
}

function TaskCard({ task, projectId, members, detailQuery, canWrite, saving, dragging, previous, next, onDragStart, onDragEnd, onMove, onArchive }: {
  task: Task; projectId: string; members: Member[]; detailQuery: string; canWrite: boolean; saving: boolean; dragging: boolean;
  previous?: Task; next?: Task; onDragStart: () => void; onDragEnd: () => void; onMove: (change: TaskChange) => void; onArchive: () => void;
}) {
  const movable = canWrite && !task.archived;
  return <article className={"task-card" + (dragging ? " dragging" : "") + (saving ? " saving" : "")} data-task-id={task.id}
    draggable={movable} aria-busy={saving || undefined}
    onDragStart={(event) => {
      event.dataTransfer.setData("text/plain", task.id);
      event.dataTransfer.effectAllowed = "move";
      onDragStart();
    }} onDragEnd={onDragEnd}>
    <TaskCardBody task={task} projectId={projectId} href={taskHref(projectId, task.id) + detailQuery} members={members}
      menu={canWrite && <Menu className="task-menu" buttonLabel={task.title + " 관리"} buttonClassName="icon-button" label={<Icon name="more" />}>
        {(close) => <div className="menu-list">
          {movable && previous && <button type="button" className="menu-item" onClick={() => { close(); onMove({ status: task.status, position: previous.position }); }}>
            <Icon name="up" />위로 이동</button>}
          {movable && next && <button type="button" className="menu-item" onClick={() => { close(); onMove({ status: task.status, position: next.position + 1 }); }}>
            <Icon name="down" />아래로 이동</button>}
          {movable && statuses.filter(([value]) => value !== task.status).map(([value, label]) => <button type="button" className="menu-item" key={value}
            onClick={() => { close(); onMove({ status: value }); }}><span className={"status-dot status-" + value} aria-hidden="true" />{label}으로 이동</button>)}
          <button type="button" className="menu-item" onClick={() => { close(); onArchive(); }}>{task.archived ? "복원" : "보관"}</button>
        </div>}
      </Menu>} />
  </article>;
}

function QuickAdd({ label, create }: { label: string; create: (title: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    if (await create(title.trim())) setTitle("");
    setBusy(false);
    input.current?.focus();
  }

  if (!open) return <button ref={trigger} type="button" className="quick-add-button" onClick={() => setOpen(true)}>
    <Icon name="plus" />{label}에 추가</button>;

  return <form className="quick-add" onSubmit={submit} onKeyDown={(event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      setTitle("");
      requestAnimationFrame(() => trigger.current?.focus());
    }
  }}>
    <input ref={input} aria-label={label + " 새 작업 제목"} placeholder="작업 제목" maxLength={160} value={title}
      readOnly={busy} onChange={(event) => setTitle(event.target.value)} />
    <div className="row">
      <button className="primary small-button" disabled={busy || !title.trim()}>추가</button>
      <button type="button" className="small-button" onClick={() => { setOpen(false); setTitle(""); }}>취소</button>
    </div>
  </form>;
}
