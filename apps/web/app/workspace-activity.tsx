"use client";

import { Badge, Button, NativeSelect } from "@mantine/core";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { displayName } from "../lib/people";
import { itemHref, projectHref, taskHref, versionHref, versionLink } from "../lib/routes";
import { addDays, shortDate, todayInSeoul } from "../lib/task-dates";
import { spanLabel, taskSpan, weekStart } from "./task-timeline";
import { statusLabel } from "./task-editor";
import { TaskStatusBadge } from "./task-status-badge";
import { EmptyState, InlineError, LoadingRows } from "./request-states";

type Dashboard = components["schemas"]["Dashboard"];
type DashboardTask = Dashboard["tasks"][number];
type DashboardOverview = components["schemas"]["DashboardOverview"];
type Activity = components["schemas"]["Activity"];

const filters = [
  ["assigned", "내 담당", "assigned_count"], ["review", "팀 검토 대기", "review_count"],
  ["due", "7일 내 마감", "due_soon_count"], ["late", "지연", "late_count"],
] as const;
const actions: Record<string, string> = {
  "project.created": "프로젝트 생성", "project.archived": "프로젝트 보관", "project.restored": "프로젝트 복원",
  "invitation.created": "팀원 초대", "invitation.accepted": "초대 수락", "membership.changed": "팀원 권한 변경",
  "media.created": "음원 추가", "media.archive_changed": "음원 보관 상태 변경",
  "version.queued": "버전 등록", "version.ready": "재생본 준비", "version.failed": "음원 처리 실패", "version.retried": "처리 재시도",
  "note.created": "피드백 작성", "note.updated": "피드백 변경", "reply.created": "답글 작성", "reply.updated": "답글 변경",
  "task.created": "작업 생성", "task.updated": "작업 변경", "task.unassigned": "담당자 해제",
};
const localDate = new Intl.DateTimeFormat("ko-KR", { dateStyle: "full", timeZone: "Asia/Seoul" });
const localTime = new Intl.DateTimeFormat("ko-KR", { timeStyle: "short", timeZone: "Asia/Seoul" });

export function DashboardPanel() {
  const requested = useSearchParams().get("filter");
  const filter = filters.find(([key]) => key === requested)?.[0] ?? "assigned";

  return <main className="main-content">
    <h1 className="section-header">내 작업</h1>
    <div className="work-dashboard">
      <DashboardTasks key={filter} filter={filter} />
      <WaitingForReview />
    </div>
  </main>;
}

function DashboardTasks({ filter }: { filter: typeof filters[number][0] }) {
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

  return <section aria-label="내 작업 목록">
    <nav aria-label="내 작업 필터" className="row wrap work-filters">
      {filters.map(([key, label, count]) => (
        <Button component={Link} variant="default" key={key} aria-current={filter === key ? "page" : undefined}
          href={"/work?filter=" + key}>{label}{dashboard && <strong> {dashboard[count]}</strong>}</Button>
      ))}
    </nav>
    {filter === "review" && <p className="muted">참여 중인 프로젝트에서 검토를 기다리는 작업입니다.</p>}
    {error && <InlineError message={error} retry={() => { setError(""); setAttempt((value) => value + 1); }} />}
    {!dashboard && !error && <LoadingRows label="작업을 불러오는 중" />}
    {dashboard?.tasks.length === 0 && <EmptyState message="이 조건에 해당하는 작업이 없습니다." />}
    {dashboard && <TaskDueGroups tasks={dashboard.tasks} />}
    {filter === "assigned" && dashboard && <MySchedule tasks={dashboard.tasks}
      hasMore={Boolean(dashboard.next_cursor)} />}
    {dashboard?.next_cursor && <Button variant="default" loading={loadingMore} onClick={() => void loadMore()}>작업 더 보기</Button>}
  </section>;
}

function TaskDueGroups({ tasks }: { tasks: DashboardTask[] }) {
  const today = todayInSeoul();
  const nextWeek = addDays(weekStart(today), 7);
  const groups: [string, DashboardTask[]][] = [
    ["지연", []], ["오늘", []], ["이번 주", []], ["다음 주 이후", []], ["날짜 없음", []],
  ];

  for (const task of tasks) {
    const due = task.due_on;
    const group = !due ? 4 : due < today ? 0 : due === today ? 1 : due < nextWeek ? 2 : 3;
    groups[group][1].push(task);
  }

  return <div className="work-groups">
    {groups.map(([label, rows]) => <section aria-label={label} key={label}>
      <h2>{label} <Badge variant="light">{rows.length}</Badge></h2>
      {rows.length === 0 ? <p className="muted">작업 없음</p> : <ul className="resource-list">
        {rows.map((task) => <li className="row spread wrap" key={task.id}>
          <div><Link className="resource-title" href={taskHref(task.project_id, task.id)}>{task.title}</Link>
            <div className="muted">{task.project_title}{task.assignee && " · " + displayName(task.assignee)}</div></div>
          <div className="row wrap"><TaskStatusBadge status={task.status} />
            {task.due_on && <time dateTime={task.due_on}>{shortDate(task.due_on)}</time>}</div>
        </li>)}
      </ul>}
    </section>)}
  </div>;
}

function MySchedule({ tasks, hasMore }: { tasks: DashboardTask[]; hasMore: boolean }) {
  const today = todayInSeoul();
  const firstWeek = weekStart(today);
  const weeks = [["이번 주", firstWeek], ["다음 주", addDays(firstWeek, 7)]];

  return <section className="work-schedule" aria-label="내 2주 일정">
    <h2>내 2주 일정</h2>
    {hasMore && <p className="muted">불러온 작업의 일정입니다. 작업 더 보기에서 나머지를 확인하세요.</p>}
    {weeks.map(([label, start]) => {
      const end = addDays(start, 6);
      const rows = tasks.filter((task) => {
        const span = taskSpan(task, today);
        return span && span.start <= end && span.end >= start;
      });

      return <section key={start} aria-label={label + " 일정"}>
        <h3>{label} · {shortDate(start)}–{shortDate(end)}</h3>
        {rows.length === 0 ? <p className="muted">일정 없음</p> : <ul className="resource-list">
          {rows.map((task) => <li key={task.id} className="row spread wrap">
            <Link href={taskHref(task.project_id, task.id)}>{task.title}</Link>
            <span className="muted">{task.project_title} · {spanLabel(task)}</span>
          </li>)}
        </ul>}
      </section>;
    })}
  </section>;
}

function WaitingForReview() {
  const [overview, setOverview] = useState<DashboardOverview>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let request: AbortController;
    function refresh() {
      request?.abort();
      request = new AbortController();
      const { signal } = request;
      api<DashboardOverview>("/v1/dashboard/overview", { signal }).then((result) => {
        if (signal.aborted) return;
        setOverview(result);
        setError("");
      }).catch((cause) => {
        if (signal.aborted) return;
        setOverview(undefined);
        setError(describeError(cause));
      });
    }

    refresh();
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); request.abort(); };
  }, [attempt]);

  if (error) return <InlineError message={error} retry={() => setAttempt((value) => value + 1)} />;
  if (!overview) return <LoadingRows label="최근 피드백과 음원을 불러오는 중" />;

  return <aside className="work-overview">
    <section aria-label="내 음원에 온 피드백">
      <h2>내 음원에 온 피드백</h2>
      {overview.feedback.length === 0 ? <EmptyState message="최근 미해결 피드백이 없습니다." /> : <ul className="resource-list">
        {overview.feedback.map((note) => <li key={note.id}>
          <Link className="resource-title" href={versionHref({
            projectId: note.project_id, itemId: note.item_id, versionId: note.version_id, noteId: note.id, at: note.start_ms,
          })}>{note.body}</Link>
          <div className="muted">{note.project_title} · {note.item_title} · {displayName({ name: note.author_name, email: note.author_email })}</div>
        </li>)}
      </ul>}
    </section>
    <section aria-label="최근 재생 가능 음원">
      <h2>최근 재생 가능 음원</h2>
      {overview.versions.length === 0 ? <EmptyState message="재생 가능한 음원이 없습니다." /> : <ul className="resource-list">
        {overview.versions.map((version) => <li key={version.id}>
          <Link className="resource-title" href={versionHref({
            projectId: version.project_id, itemId: version.item_id, versionId: version.id,
          })}>{version.filename}</Link>
          <div className="muted">{version.project_title} · {version.item_title}</div>
        </li>)}
      </ul>}
    </section>
  </aside>;
}

function activityHref(projectId: string, entry: Activity) {
  const family = entry.action.split(".")[0];
  const detail = entry.detail;
  if (family === "task") return taskHref(projectId, entry.subject_id);
  if (family === "version") return versionLink(projectId, entry.subject_id);
  if (family === "media") return itemHref(projectId, entry.subject_id);
  if ((family === "note" || family === "reply") && typeof detail.version_id === "string") {
    const note = family === "note" ? entry.subject_id : typeof detail.note_id === "string" ? detail.note_id : undefined;
    return versionLink(projectId, detail.version_id, note);
  }
  if (family === "membership" || family === "invitation" || family === "project") return projectHref(projectId, "settings");
}

export function ProjectActivity({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const type = useSearchParams().get("type") ?? "";
  return <section aria-label="프로젝트 활동">
    <div className="row spread wrap section-header">
      <h2 className="section-title">프로젝트 활동</h2>
      <NativeSelect label="활동 종류" value={type} onChange={(event) => {
        const value = event.currentTarget.value;
        router.push(pathname + (value ? "?" + new URLSearchParams({ type: value }) : ""));
      }} data={[
        { value: "", label: "전체" }, { value: "media", label: "음원" }, { value: "version", label: "버전" },
        { value: "note", label: "피드백" }, { value: "reply", label: "답글" }, { value: "task", label: "작업" },
        { value: "membership", label: "팀원" }, { value: "invitation", label: "초대" }, { value: "project", label: "프로젝트" },
      ]} />
    </div>
    <ActivityEntries key={type} projectId={projectId} type={type} />
  </section>;
}

function ActivityEntries({ projectId, type }: { projectId: string; type: string }) {
  const path = "/v1/projects/" + projectId + "/activity?" + new URLSearchParams({ type });
  const [events, setEvents] = useState<Activity[]>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const request = new AbortController();

    api<Activity[]>(path, { signal: request.signal }).then((rows) => {
      if (request.signal.aborted) return;
      setEvents(rows);
      setMore(rows.length === 50);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [path, attempt]);

  async function loadMore() {
    const before = events?.at(-1)?.id;
    if (!before || busy) return;
    setBusy(true);
    try {
      const rows = await api<Activity[]>(path + "&before=" + before);
      setEvents((previous) => [...(previous ?? []), ...rows.filter((entry) => !previous?.some(({ id }) => id === entry.id))]);
      setMore(rows.length === 50);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  const groups = new Map<string, Activity[]>();
  for (const event of events ?? []) {
    const day = localDate.format(new Date(event.created_at));
    const group = groups.get(day);
    if (group) group.push(event);
    else groups.set(day, [event]);
  }

  return <>
    {error && <InlineError message={error} retry={() => { setError(""); setAttempt((value) => value + 1); }} />}
    {!events && !error && <LoadingRows label="활동을 불러오는 중" />}
    {events?.length === 0 && <EmptyState message="이 조건에 해당하는 활동이 없습니다." />}
    {[...groups].map(([date, rows]) => <section className="activity-day" key={date}>
      <h3>{date}</h3>
      <ul className="clean-list">
        {rows.map((entry) => {
          const href = activityHref(projectId, entry);
          const label = actions[entry.action] ?? entry.action;
          const status = entry.detail.status;
          return <li className="row spread wrap" key={entry.id}>
            <span>{href ? <Link href={href} className="resource-title">{label}</Link> : label}
              {typeof status === "string" && " · " + statusLabel(status)}
              <span className="muted"> · {entry.actor_name || entry.actor}</span>
            </span>
            <time className="muted" dateTime={entry.created_at}>{localTime.format(new Date(entry.created_at))}</time>
          </li>;
        })}
      </ul>
    </section>)}
    {more && <Button variant="default" loading={busy} onClick={() => void loadMore()}>이전 활동 더 보기</Button>}
  </>;
}
