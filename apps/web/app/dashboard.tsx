"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { displayName } from "../lib/people";
import { taskHref, versionHref, versionLink } from "../lib/routes";
import { addDays, daysBetween, shortDate, statuses, todayInSeoul } from "../lib/tasks";
import { FeedbackCount, SourceChip, sourceRange } from "./task-card";
import { spanLabel, taskSpan, weekStart } from "./task-timeline";
import { Avatar, CountBadge, DueChip, Icon, Person, StatusChip, Unassigned, type IconName } from "./ui";
import { useWorkspace } from "./workspace";

type Dashboard = components["schemas"]["Dashboard"];
type DashboardTask = components["schemas"]["DashboardTask"];
type Overview = components["schemas"]["DashboardOverview"];
type Inbox = components["schemas"]["Inbox"];
type Filter = "assigned" | "late" | "due" | "review";
type View = "list" | "board" | "timeline";

const filters: [Filter, string, keyof Dashboard, IconName][] = [
  ["assigned", "내 담당", "assigned_count", "users"], ["late", "지연", "late_count", "alert"],
  ["due", "7일 내 마감", "due_soon_count", "calendar"], ["review", "팀 검토 대기", "review_count", "inbox"],
];
const views: [View, string, IconName][] = [["list", "목록", "list"], ["board", "보드", "board"], ["timeline", "일정", "timeline"]];
const relative = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
const fullDate = new Intl.DateTimeFormat("ko-KR", { dateStyle: "full", timeZone: "Asia/Seoul" });

function ago(value: string) {
  const minutes = Math.round((Date.parse(value) - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  if (Math.abs(minutes) < 60 * 24) return relative.format(Math.round(minutes / 60), "hour");
  return relative.format(Math.round(minutes / 60 / 24), "day");
}

function describe(action: string) {
  return action === "reply.created" ? "새 답글" : "작업이 배정됐습니다";
}

export function DashboardPanel() {
  const query = useSearchParams();
  const { session } = useWorkspace();
  const filter = filters.find(([key]) => key === query.get("filter"))?.[0] ?? "assigned";
  const view = views.find(([key]) => key === query.get("view"))?.[0] ?? "list";
  const href = (next: { filter?: Filter; view?: View }) => {
    const params = new URLSearchParams();
    const nextFilter = next.filter ?? filter;
    const nextView = next.view ?? view;
    if (nextFilter !== "assigned") params.set("filter", nextFilter);
    if (nextView !== "list") params.set("view", nextView);
    return "/work" + (params.size ? "?" + params : "");
  };

  return <main className="main-content dashboard">
    <div className="row spread wrap section-header dashboard-head">
      <div>
        <h1>내 대시보드</h1>
        <p className="muted">{displayName(session)}님, {fullDate.format(new Date())}</p>
      </div>
      <nav className="segmented view-switch" aria-label="대시보드 보기">
        {views.map(([value, label, icon]) => <Link key={value} className="button" href={href({ view: value })}
          aria-current={view === value ? "page" : undefined}><Icon name={icon} />{label}</Link>)}
      </nav>
    </div>
    <DashboardBody key={filter} filter={filter} view={view} href={href} />
  </main>;
}

function DashboardBody({ filter, view, href }: { filter: Filter; view: View; href: (next: { filter?: Filter; view?: View }) => string }) {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const path = "/v1/dashboard?filter=" + filter;

  useEffect(() => {
    const request = new AbortController();
    function refresh() {
      api<Dashboard>(path, { signal: request.signal }).then((result) => {
        if (request.signal.aborted) return;
        setDashboard(result);
        setError("");
      }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    }

    refresh();
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); request.abort(); };
  }, [attempt, path]);

  async function loadMore() {
    if (!dashboard?.next_cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<Dashboard>(path + "&after=" + dashboard.next_cursor);
      setDashboard((previous) => previous ? {
        ...page, tasks: [...previous.tasks, ...page.tasks.filter((task) => !previous.tasks.some(({ id }) => id === task.id))],
      } : page);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  const [, label] = filters.find(([key]) => key === filter)!;
  const tasks = dashboard?.tasks ?? [];
  return <>
    <nav aria-label="내 작업 필터" className="stat-cards">
      {filters.map(([key, title, count, icon]) => <Link key={key} className={"stat-card stat-" + key} href={href({ filter: key })}
        aria-current={filter === key ? "page" : undefined}>
        <span className="stat-icon" aria-hidden="true"><Icon name={icon} size={18} /></span>
        <span className="stat-label">{title}</span>
        <strong>{dashboard ? dashboard[count] as number : "–"}</strong>
      </Link>)}
    </nav>
    <div className="dashboard-grid">
      <section className="dashboard-main" aria-label="내 작업 목록">
        <h2 className="section-title">{label} 작업 {dashboard && <span className="lane-count">{tasks.length}{dashboard.next_cursor ? "+" : ""}</span>}</h2>
        {filter === "review" && <p className="muted small">참여 중인 프로젝트에서 검토를 기다리는 작업입니다.</p>}
        {error && <div className="row wrap" role="alert"><span className="error">{error}</span>
          <button onClick={() => setAttempt((value) => value + 1)}>다시 시도</button></div>}
        {!dashboard && !error && <p role="status">작업을 불러오는 중</p>}
        {dashboard?.tasks.length === 0 && <p className="empty muted">이 조건에 해당하는 작업이 없습니다.</p>}
        {tasks.length > 0 && (view === "board" ? <DashboardBoard tasks={tasks} showAssignee={filter === "review"} />
          : view === "timeline" ? <DashboardSchedule tasks={tasks} />
          : <DashboardList tasks={tasks} showAssignee={filter === "review"} />)}
        {dashboard?.next_cursor && <button disabled={loadingMore} onClick={() => void loadMore()}>작업 더 보기</button>}
      </section>
      <Waiting includeReview={filter !== "review"} />
    </div>
  </>;
}

function bucket(task: DashboardTask, today: string): [string, string] {
  if (!task.due_on) return ["none", "날짜 없음"];
  const days = daysBetween(today, task.due_on);
  if (days < 0) return ["late", "지연"];
  if (days === 0) return ["today", "오늘"];
  if (task.due_on <= addDays(weekStart(today), 6)) return ["week", "이번 주"];
  return ["later", "다음 주 이후"];
}

function TaskAssignee({ task }: { task: DashboardTask }) {
  return task.assignee ? <Person id={task.assignee_id} person={task.assignee} /> : <Unassigned />;
}

function DashboardList({ tasks, showAssignee }: { tasks: DashboardTask[]; showAssignee: boolean }) {
  const today = todayInSeoul();
  const groups = new Map<string, { label: string; tasks: DashboardTask[] }>();
  for (const key of ["late", "today", "week", "later", "none"]) groups.set(key, { label: "", tasks: [] });
  for (const task of tasks) {
    const [key, label] = bucket(task, today);
    const group = groups.get(key)!;
    group.label = label;
    group.tasks.push(task);
  }
  return <div className="due-groups">
    {[...groups].filter(([, group]) => group.tasks.length).map(([key, group]) => <section key={key} className={"due-group due-group-" + key} aria-label={group.label}>
      <h3>{group.label} <span className="lane-count">{group.tasks.length}</span></h3>
      <ul className="dashboard-rows">
        {group.tasks.map((task) => <li key={task.id} className="dashboard-row">
          <span className={"status-dot status-" + task.status} aria-hidden="true" />
          <div className="dashboard-row-main">
            <Link className="resource-title" href={taskHref(task.project_id, task.id)}>{task.title}</Link>
            <span className="row wrap dashboard-row-meta">
              <span className="muted small">{task.project_title}</span>
              {task.source && <SourceChip projectId={task.project_id} source={task.source} />}
            </span>
          </div>
          <span className="row wrap dashboard-row-side">
            {showAssignee && <TaskAssignee task={task} />}
            <StatusChip status={task.status} />
            <DueChip due={task.due_on} status={task.status} />
            <FeedbackCount count={task.note_count} />
          </span>
        </li>)}
      </ul>
    </section>)}
  </div>;
}

function DashboardBoard({ tasks, showAssignee }: { tasks: DashboardTask[]; showAssignee: boolean }) {
  const lanes = statuses.filter(([value]) => value !== "done");
  return <div className="board dashboard-board" style={{ ["--lanes" as string]: lanes.length }}>
    {lanes.map(([value, label]) => {
      const rows = tasks.filter((task) => task.status === value);
      return <section key={value} className={"lane lane-" + value} aria-label={label}>
        <h3 className="lane-title"><span className={"status-dot status-" + value} aria-hidden="true" />{label}<span className="lane-count">{rows.length}</span></h3>
        <ol className="lane-cards">
          {rows.map((task) => <li key={task.id}><article className="task-card">
            <Link className="resource-title task-card-title" href={taskHref(task.project_id, task.id)}>{task.title}</Link>
            <span className="muted small task-card-project">{task.project_title}</span>
            {task.source && <SourceChip projectId={task.project_id} source={task.source} />}
            <div className="task-card-meta">
              {showAssignee ? <TaskAssignee task={task} /> : <span />}
              <span className="row task-card-badges"><DueChip due={task.due_on} status={task.status} /><FeedbackCount count={task.note_count} /></span>
            </div>
          </article></li>)}
        </ol>
        {rows.length === 0 && <p className="lane-empty">작업 없음</p>}
      </section>;
    })}
  </div>;
}

/** Two weeks from this Monday, read-only: which of my tasks overlap and when they end. */
function DashboardSchedule({ tasks }: { tasks: DashboardTask[] }) {
  const today = todayInSeoul();
  const start = weekStart(today);
  const days = 14;
  const end = addDays(start, days - 1);
  const dates = Array.from({ length: days }, (_, index) => addDays(start, index));
  const scheduled = tasks.map((task) => ({ task, span: taskSpan(task, today) }))
    .filter(({ span }) => span && span.start <= end && span.end >= start)
    .sort((left, right) => left.span!.start.localeCompare(right.span!.start));
  const unscheduled = tasks.filter((task) => !taskSpan(task, today));
  return <div className="dashboard-schedule">
    <div className="mini-timeline" style={{ ["--days" as string]: days }}>
      <div className="mini-head" aria-hidden="true">
        <span />
        {dates.map((date) => <span key={date} className={(date === today ? "today " : "") + ([0, 6].includes(new Date(date + "T00:00:00Z").getUTCDay()) ? "weekend" : "")}>
          {Number(date.slice(8))}</span>)}
      </div>
      {scheduled.length === 0 && <p className="muted small mini-empty">이번 주와 다음 주에 일정이 있는 작업이 없습니다.</p>}
      {scheduled.map(({ task, span }) => {
        const from = Math.max(0, daysBetween(start, span!.start));
        const to = Math.min(days - 1, daysBetween(start, span!.end));
        return <div key={task.id} className="mini-row">
          <Link href={taskHref(task.project_id, task.id)} className="mini-label"><span>{task.title}</span><small className="muted">{task.project_title}</small></Link>
          <span className="mini-track">
            <span role="img" aria-label={task.title + ", " + spanLabel(task)} className={"mini-bar status-" + task.status + (task.due_on && task.due_on < today ? " late" : "")}
              style={{ gridColumn: from + 1 + " / " + (to + 2) }} />
          </span>
        </div>;
      })}
    </div>
    <p className="muted small">{shortDate(start)} – {shortDate(end)} · 막대를 옮기려면 프로젝트의 타임라인을 사용하세요.</p>
    {unscheduled.length > 0 && <p className="muted small">날짜 없는 작업 {unscheduled.length}개는 목록 보기에서 확인할 수 있습니다.</p>}
  </div>;
}

function WaitingSection({ title, icon, count, children }: { title: string; icon: IconName; count: number; children: ReactNode }) {
  return <section className="waiting-section" aria-label={title}>
    <h3><Icon name={icon} />{title}{count > 0 && <CountBadge value={count} />}</h3>
    {children}
  </section>;
}

function Waiting({ includeReview }: { includeReview: boolean }) {
  const [overview, setOverview] = useState<Overview>();
  const [inbox, setInbox] = useState<Inbox>();
  const [review, setReview] = useState<Dashboard>();
  const [error, setError] = useState("");

  useEffect(() => {
    const request = new AbortController();
    Promise.all([
      api<Overview>("/v1/dashboard/overview", { signal: request.signal }),
      api<Inbox>("/v1/notifications", { signal: request.signal }),
      includeReview ? api<Dashboard>("/v1/dashboard?filter=review", { signal: request.signal }) : Promise.resolve(undefined),
    ]).then(([nextOverview, nextInbox, nextReview]) => {
      if (request.signal.aborted) return;
      setOverview(nextOverview);
      setInbox(nextInbox);
      setReview(nextReview);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [includeReview]);

  const unread = inbox?.items.filter(({ read_at }) => !read_at).slice(0, 5) ?? [];
  const reviews = review?.tasks.slice(0, 5) ?? [];
  const empty = overview && inbox && !unread.length && !reviews.length && !overview.feedback.length;
  return <aside className="dashboard-side">
    <section className="dash-card" aria-label="나를 기다리는 것">
      <h2>나를 기다리는 것</h2>
      {error && <p role="alert" className="error small">{error}</p>}
      {!overview && !error && <p role="status" className="muted small">불러오는 중</p>}
      {empty && <p className="muted small">지금 기다리는 항목이 없습니다.</p>}
      {reviews.length > 0 && <WaitingSection title="검토 요청" icon="inbox" count={review?.review_count ?? 0}>
        <ul className="waiting-list">{reviews.map((task) => <li key={task.id}>
          <Link href={taskHref(task.project_id, task.id)}>{task.title}</Link>
          <small className="muted">{task.project_title}{task.assignee ? " · " + displayName(task.assignee) : ""}</small>
        </li>)}</ul>
        {(review?.review_count ?? 0) > reviews.length && <Link className="small" href="/work?filter=review">모두 보기</Link>}
      </WaitingSection>}
      {unread.length > 0 && <WaitingSection title="읽지 않은 알림" icon="bell" count={inbox?.unread ?? 0}>
        <ul className="waiting-list">{unread.map((notice) => <li key={notice.id} className="with-avatar">
          {notice.actor_id ? <Avatar id={notice.actor_id} person={{ name: notice.actor_name, email: notice.actor_email }} /> : <span className="avatar avatar-md avatar-empty" aria-hidden="true" />}
          <span>
            <Link href={notice.version_id ? versionLink(notice.project_id, notice.version_id, notice.note_id || undefined)
              : taskHref(notice.project_id, notice.subject_id)}>{describe(notice.action)}</Link>
            {notice.title && <span className="waiting-quote">{notice.title}</span>}
            <small className="muted">{notice.actor_id ? displayName({ name: notice.actor_name, email: notice.actor_email }) + " · " : ""}{notice.project_title} · {ago(notice.created_at)}</small>
          </span>
        </li>)}</ul>
      </WaitingSection>}
      {overview && overview.feedback.length > 0 && <WaitingSection title="내 음원에 온 피드백" icon="message" count={overview.feedback.length}>
        <ul className="waiting-list">{overview.feedback.map((note) => <li key={note.id} className="with-avatar">
          <Avatar id={note.author_id} person={{ name: note.author_name, email: note.author_email }} />
          <span>
            <Link href={versionHref({ projectId: note.project_id, itemId: note.item_id, versionId: note.version_id, noteId: note.id, at: note.start_ms })}>
              {note.item_title} · {sourceRange(note)}</Link>
            <span className="waiting-quote">{note.body}</span>
            <small className="muted">{displayName({ name: note.author_name, email: note.author_email })} · {note.filename} · {ago(note.created_at)}</small>
          </span>
        </li>)}</ul>
      </WaitingSection>}
    </section>
    <section className="dash-card" aria-label="최근 음원">
      <h2>최근 음원</h2>
      {overview?.versions.length === 0 && <p className="muted small">아직 올라온 음원이 없습니다.</p>}
      <ul className="waiting-list">{overview?.versions.map((version) => <li key={version.id} className="with-avatar">
        <span className="project-mark" aria-hidden="true"><Icon name="music" /></span>
        <span>
          <Link href={versionHref({ projectId: version.project_id, itemId: version.item_id, versionId: version.id })}>{version.item_title}</Link>
          <small className="muted">{version.filename} · {version.project_title}</small>
          <small className="muted">{displayName({ name: version.uploader_name, email: version.uploader_email })} · {ago(version.created_at)}
            {version.open_notes > 0 && <> · 미해결 피드백 {version.open_notes}</>}</small>
        </span>
      </li>)}</ul>
    </section>
  </aside>;
}
