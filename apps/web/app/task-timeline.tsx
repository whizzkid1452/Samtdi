"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { displayName } from "../lib/people";
import { taskHref, versionHref } from "../lib/routes";
import { addDays, daysBetween, shortDate, statusLabel, statuses, todayInSeoul } from "../lib/tasks";
import { Assignee } from "./task-card";
import type { Task } from "./task-editor";
import type { TaskUpdate } from "./task-actions";
import { Icon, Person, StatusChip, Unassigned } from "./ui";
import type { Member } from "./workspace";

type ScheduleVersion = components["schemas"]["ScheduleVersion"];
export type Zoom = "week" | "month";
const zooms: Record<Zoom, { days: number; width: number; step: number; label: string }> = {
  week: { days: 28, width: 36, step: 7, label: "주" },
  month: { days: 63, width: 16, step: 28, label: "월" },
};
const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
const pageSize = 100;
type Drag = { id: string; mode: "move" | "start" | "end"; x: number; delta: number; moved: boolean };

function weekday(date: string) {
  return new Date(date + "T00:00:00Z").getUTCDay();
}

/** Monday of the week that contains the date. */
export function weekStart(date: string) {
  return addDays(date, -((weekday(date) + 6) % 7));
}

/** The calendar span a task occupies; a start without a due date runs to today, a due date alone is a milestone. */
export function taskSpan(task: Pick<Task, "start_on" | "due_on">, today: string) {
  if (!task.start_on && !task.due_on) return undefined;
  const start = task.start_on || task.due_on;
  const end = task.due_on || (task.start_on < today ? today : task.start_on);
  return { start, end, open: !task.due_on, milestone: !task.start_on };
}

export function spanLabel(task: Pick<Task, "start_on" | "due_on">) {
  if (task.start_on && task.due_on) return task.start_on === task.due_on ? shortDate(task.due_on) : shortDate(task.start_on) + " – " + shortDate(task.due_on);
  if (task.due_on) return shortDate(task.due_on) + " 마감";
  if (task.start_on) return shortDate(task.start_on) + "부터";
  return "날짜 없음";
}

function subscribe(change: () => void) {
  const query = matchMedia("(max-width: 800px)");
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}

function useNarrow() {
  return useSyncExternalStore(subscribe, () => matchMedia("(max-width: 800px)").matches, () => false);
}

async function loadAll(path: string, signal: AbortSignal) {
  const rows: Task[] = [];
  for (let page = 0; page < 5; page++) {
    const next = await api<Task[]>(path + (rows.length ? "&after=" + rows.at(-1)!.id : ""), { signal });
    rows.push(...next);
    if (next.length < pageSize) return { rows, partial: false };
  }
  return { rows, partial: true };
}

export function TaskTimeline({ base, projectId, members, canWrite, apiQuery, detailQuery, group, zoom, start: requestedStart, refresh, onMove }: {
  base: string; projectId: string; members: Member[]; canWrite: boolean; apiQuery: string; detailQuery: string;
  group: "assignee" | "status"; zoom: Zoom; start?: string; refresh: number;
  onMove: (task: Task, change: TaskUpdate) => Promise<void>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const narrow = useNarrow();
  const today = todayInSeoul();
  const { days, width, step } = zooms[zoom];
  const start = requestedStart ?? addDays(weekStart(today), -7);
  const end = addDays(start, days - 1);
  const dates = Array.from({ length: days }, (_, index) => addDays(start, index));
  const [data, setData] = useState<{ key: string; tasks: Task[]; partial: boolean; unscheduled: Task[]; versions: ScheduleVersion[] }>();
  const [error, setError] = useState("");
  const [drag, setDrag] = useState<Drag>();
  const [dropDay, setDropDay] = useState<number>();
  const [saving, setSaving] = useState<string>();
  const grid = useRef<HTMLDivElement>(null);
  const key = [base, apiQuery, start, end, refresh].join("|");

  useEffect(() => {
    const request = new AbortController();
    const query = (extra: Record<string, string>) => base + "/tasks?" + new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(apiQuery)), ...extra });
    Promise.all([
      loadAll(query({ from: start, to: end }), request.signal),
      api<Task[]>(query({ scheduled: "false" }), { signal: request.signal }),
      api<ScheduleVersion[]>(base + "/versions?" + new URLSearchParams({ from: start, to: end }), { signal: request.signal }),
    ]).then(([scheduled, unscheduled, versions]) => {
      if (request.signal.aborted) return;
      setData({ key, tasks: scheduled.rows, partial: scheduled.partial, unscheduled, versions });
      setError("");
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [apiQuery, base, end, key, start]);

  function navigate(changes: Record<string, string>) {
    const params = new URLSearchParams(window.location.search);
    for (const [name, value] of Object.entries(changes)) {
      if (value) params.set(name, value);
      else params.delete(name);
    }
    router.push(pathname + (params.size ? "?" + params : ""));
  }

  const tasks = data?.tasks ?? [];
  const groups = group === "status"
    ? statuses.map(([value, label]) => ({ key: value, label, head: <StatusChip status={value} />, tasks: tasks.filter((task) => task.status === value) }))
    : [...members.filter(({ role }) => role !== "reviewer").map((member) => ({
      key: member.account_id, label: displayName(member), head: <Person id={member.account_id} person={member} size="md" />,
      tasks: tasks.filter((task) => task.assignee_id === member.account_id),
    })), {
      key: "others", label: "이전 팀원", head: <span className="person"><span className="avatar avatar-md avatar-empty" aria-hidden="true" /><span className="person-name">이전 팀원</span></span>,
      tasks: tasks.filter((task) => task.assignee_id && !members.some(({ account_id, role }) => account_id === task.assignee_id && role !== "reviewer")),
    }, { key: "unassigned", label: "미할당", head: <Unassigned />, tasks: tasks.filter((task) => !task.assignee_id) }];
  const visibleGroups = groups.filter((entry) => entry.tasks.length > 0);
  for (const entry of visibleGroups) entry.tasks.sort((left, right) => (taskSpan(left, today)?.start ?? "").localeCompare(taskSpan(right, today)?.start ?? "") || left.title.localeCompare(right.title));

  function shifted(task: Task, current: Drag) {
    const span = taskSpan(task, today);
    if (!span || !current.delta) return { start_on: task.start_on, due_on: task.due_on };
    const move = (date: string) => date && addDays(date, current.delta);
    if (current.mode === "move") return { start_on: move(task.start_on), due_on: move(task.due_on) };
    if (current.mode === "start") {
      const next = addDays(span.start, current.delta);
      return { start_on: task.due_on && next > task.due_on ? task.due_on : next, due_on: task.due_on };
    }
    const next = addDays(span.end, current.delta);
    const first = task.start_on || task.due_on;
    return { start_on: task.start_on, due_on: first && next < first ? first : next };
  }

  function beginDrag(event: ReactPointerEvent<HTMLElement>, task: Task, mode: Drag["mode"]) {
    if (!canWrite || task.archived || event.button !== 0 || !event.isPrimary) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id: task.id, mode, x: event.clientX, delta: 0, moved: false });
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    if (!drag) return;
    const delta = Math.round((event.clientX - drag.x) / width);
    if (delta !== drag.delta || (!drag.moved && Math.abs(event.clientX - drag.x) > 4)) setDrag({ ...drag, delta, moved: drag.moved || Math.abs(event.clientX - drag.x) > 4 });
  }

  async function endDrag(task: Task) {
    const current = drag;
    if (!current) return;
    setDrag(undefined);
    if (!current.moved) {
      router.push(taskHref(projectId, task.id) + detailQuery);
      return;
    }
    const next = shifted(task, current);
    if (next.start_on === task.start_on && next.due_on === task.due_on) return;
    setSaving(task.id);
    await onMove(task, next);
    setSaving(undefined);
  }

  function dayAt(event: DragEvent<HTMLElement>) {
    const track = grid.current?.querySelector<HTMLElement>(".timeline-day")?.getBoundingClientRect();
    if (!track) return undefined;
    const index = Math.floor((event.clientX - track.left) / width);
    return index >= 0 && index < days ? index : undefined;
  }

  const rangeLabel = shortDate(start) + " – " + shortDate(end);
  const toolbar = <div className="row wrap spread timeline-toolbar">
    <div className="row wrap">
      <div className="segmented" role="group" aria-label="기간 이동">
        <button type="button" aria-label={"이전 " + step + "일"} onClick={() => navigate({ start: addDays(start, -step) })}><Icon name="left" /></button>
        <button type="button" onClick={() => navigate({ start: "" })}>오늘</button>
        <button type="button" aria-label={"다음 " + step + "일"} onClick={() => navigate({ start: addDays(start, step) })}><Icon name="right" /></button>
      </div>
      <strong className="timeline-range">{rangeLabel}</strong>
    </div>
    <div className="segmented" role="group" aria-label="타임라인 단위">
      {(Object.keys(zooms) as Zoom[]).map((value) => <button key={value} type="button" aria-pressed={zoom === value}
        onClick={() => navigate({ zoom: value === "week" ? "" : value, start: "" })}>{zooms[value].label}</button>)}
    </div>
  </div>;

  const tray = data && data.unscheduled.length > 0 && <div className="timeline-tray" aria-label="날짜 없는 작업" role="group">
    <strong>날짜 없음 <span className="lane-count">{data.unscheduled.length}{data.unscheduled.length === pageSize ? "+" : ""}</span></strong>
    {!narrow && canWrite && <span className="muted small">타임라인으로 끌어 놓으면 그날로 일정을 정합니다.</span>}
    <ul>{data.unscheduled.map((task) => <li key={task.id}>
      <Link className={"tray-chip status-" + task.status} href={taskHref(projectId, task.id) + detailQuery} draggable={canWrite && !narrow}
        onDragStart={(event) => { event.dataTransfer.setData("text/plain", task.id); event.dataTransfer.effectAllowed = "move"; }}>
        <span className={"status-dot status-" + task.status} aria-hidden="true" />{task.title}
      </Link>
    </li>)}</ul>
  </div>;

  if (narrow) return <section className="timeline" aria-label="타임라인">
    {toolbar}
    {error && <p role="alert" className="error">{error}</p>}
    {!data && !error && <p role="status">일정을 불러오는 중</p>}
    {data && <Agenda tasks={tasks} start={start} days={days} today={today} projectId={projectId} members={members} detailQuery={detailQuery} />}
    {tray}
  </section>;

  const todayIndex = daysBetween(start, today);
  return <section className="timeline" aria-label="타임라인">
    {toolbar}
    {error && <p role="alert" className="error">{error}</p>}
    {!data && !error && <p role="status">일정을 불러오는 중</p>}
    {data?.partial && <p className="muted small">이 기간의 작업이 많아 처음 {pageSize * 5}개만 표시합니다. 필터로 범위를 좁혀 주세요.</p>}
    <div className="timeline-scroll">
      <div className={"timeline-grid zoom-" + zoom} ref={grid} style={{ ["--day" as string]: width + "px", ["--days" as string]: days }}>
        <div className="timeline-head" aria-hidden="true">
          <div className="timeline-corner">{group === "status" ? "상태" : "담당자"} · 작업</div>
          {dates.map((date) => {
            const day = weekday(date);
            const showDate = zoom === "week" || day === 1 || date.endsWith("-01");
            return <div key={date} className={"timeline-day" + (day === 0 || day === 6 ? " weekend" : "") + (date === today ? " today" : "")}>
              {zoom === "week" && <span>{weekdays[day]}</span>}
              <strong>{showDate ? (zoom === "week" ? Number(date.slice(8)) : Number(date.slice(5, 7)) + "/" + Number(date.slice(8))) : ""}</strong>
            </div>;
          })}
        </div>
        <div className={"timeline-body" + (dropDay !== undefined ? " dropping" : "")}
          onDragOver={canWrite ? (event) => { event.preventDefault(); setDropDay(dayAt(event)); } : undefined}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropDay(undefined); }}
          onDrop={canWrite ? (event) => {
            event.preventDefault();
            const index = dayAt(event);
            const task = data?.unscheduled.find(({ id }) => id === event.dataTransfer.getData("text/plain"));
            setDropDay(undefined);
            if (task && index !== undefined) void onMove(task, { start_on: dates[index], due_on: dates[index] });
          } : undefined}>
          <div className="timeline-columns" aria-hidden="true">
            {dates.map((date) => <span key={date} className={(weekday(date) % 6 === 0 ? "weekend" : "") + (date === today ? " today" : "")} />)}
          </div>
          {todayIndex >= 0 && todayIndex < days && <div className="timeline-today" style={{ left: `calc(var(--label) + ${todayIndex + .5} * var(--day))` }}><span>오늘</span></div>}
          {data?.versions.map((version) => {
            const index = daysBetween(start, new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(version.created_at)));
            return <Link key={version.id} className="timeline-version" style={{ left: `calc(var(--label) + ${index + .5} * var(--day))` }}
              href={versionHref({ projectId, itemId: version.item_id, versionId: version.id })} title={version.item_title + " · " + version.filename}>
              <span>{version.filename}</span><span className="visually-hidden">{shortDate(dates[index] ?? start)} 업로드</span>
            </Link>;
          })}
          {dropDay !== undefined && <div className="timeline-drop" style={{ left: `calc(var(--label) + ${dropDay} * var(--day))` }} aria-hidden="true" />}
          {data && visibleGroups.length === 0 && <p className="timeline-empty muted">이 기간에 일정이 있는 작업이 없습니다. 아래 날짜 없는 작업을 끌어 놓거나 작업에 시작일·마감일을 정해 보세요.</p>}
          {visibleGroups.map((entry) => <div className="timeline-group" role="group" aria-label={entry.label + " 일정"} key={entry.key}>
            <div className="timeline-group-head">{entry.head}<span className="lane-count">{entry.tasks.length}</span></div>
            {entry.tasks.map((task) => {
              const current = drag?.id === task.id ? drag : undefined;
              const preview = current ? { ...task, ...shifted(task, current) } : task;
              const span = taskSpan(preview, today)!;
              const from = daysBetween(start, span.start);
              const to = daysBetween(start, span.end);
              const left = Math.max(0, from);
              const right = Math.min(days - 1, to);
              const late = task.status !== "done" && !!task.due_on && task.due_on < today;
              const label = task.title + ", " + (members.find(({ account_id }) => account_id === task.assignee_id) ? "담당 " + displayName(members.find(({ account_id }) => account_id === task.assignee_id)!) : "미할당") +
                ", " + spanLabel(preview) + ", " + statusLabel(task.status) + (late ? ", 지연" : "");
              return <div className="timeline-row" key={task.id}>
                <div className="timeline-label"><Link href={taskHref(projectId, task.id) + detailQuery}>{task.title}</Link></div>
                <div className="timeline-track">
                  {right >= left && <div role="img" aria-label={label}
                    className={"timeline-bar status-" + task.status + (late ? " late" : "") + (span.milestone && span.start === span.end ? " milestone" : "") +
                      (span.open ? " open" : "") + (from < 0 ? " clipped-start" : "") + (to > days - 1 ? " clipped-end" : "") + (current ? " dragging" : "") + (saving === task.id ? " saving" : "") +
                      (canWrite && !task.archived ? " editable" : "")}
                    style={{ left: left * width, width: (right - left + 1) * width }}
                    onPointerDown={(event) => beginDrag(event, task, "move")} onPointerMove={moveDrag}
                    onPointerUp={() => void endDrag(task)} onPointerCancel={() => setDrag(undefined)}>
                    {canWrite && !task.archived && !(span.milestone && span.start === span.end) && <>
                      <span className="bar-handle start" aria-hidden="true" onPointerDown={(event) => beginDrag(event, task, "start")} onPointerMove={moveDrag} onPointerUp={() => void endDrag(task)} />
                      <span className="bar-handle end" aria-hidden="true" onPointerDown={(event) => beginDrag(event, task, "end")} onPointerMove={moveDrag} onPointerUp={() => void endDrag(task)} />
                    </>}
                    <span className="timeline-bar-label" aria-hidden="true">{span.milestone && span.start === span.end ? "" : task.title}</span>
                  </div>}
                </div>
              </div>;
            })}
          </div>)}
        </div>
      </div>
    </div>
    {tray}
  </section>;
}

/** Narrow screens list the same schedule by week instead of drawing bars. */
function Agenda({ tasks, start, days, today, projectId, members, detailQuery }: {
  tasks: Task[]; start: string; days: number; today: string; projectId: string; members: Member[]; detailQuery: string;
}) {
  const weeks = Array.from({ length: Math.ceil(days / 7) }, (_, index) => addDays(start, index * 7));
  return <div className="agenda">
    {weeks.map((week) => {
      const last = addDays(week, 6);
      const rows = tasks.filter((task) => {
        const span = taskSpan(task, today);
        return span && span.start <= last && span.end >= week;
      }).sort((left, right) => (taskSpan(left, today)!.start).localeCompare(taskSpan(right, today)!.start));
      return <section key={week} className="agenda-week" aria-label={shortDate(week) + " 주"}>
        <h3>{shortDate(week)} – {shortDate(last)}{week <= today && today <= last && <span className="status-label">이번 주</span>}</h3>
        {rows.length === 0 ? <p className="muted small">일정 없음</p> : <ul>
          {rows.map((task) => <li key={task.id}>
            <Link className="resource-title" href={taskHref(projectId, task.id) + detailQuery}>{task.title}</Link>
            <span className="row wrap"><StatusChip status={task.status} /><span className="muted small">{spanLabel(task)}</span>
              <Assignee members={members} id={task.assignee_id} /></span>
          </li>)}
        </ul>}
      </section>;
    })}
  </div>;
}
