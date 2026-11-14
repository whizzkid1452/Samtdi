"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { itemHref, projectHref, taskHref, versionLink } from "../lib/routes";
import { displayName } from "../lib/people";
import { Avatar, DueChip, StatusChip } from "./ui";

type Dashboard = components["schemas"]["Dashboard"];
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
    <DashboardTasks key={filter} filter={filter} />
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
      {filters.map(([key, label, count]) => <Link className="button" key={key} aria-current={filter === key ? "page" : undefined}
        href={"/work?filter=" + key}>{label}{dashboard && <strong> {dashboard[count]}</strong>}</Link>)}
    </nav>
    {filter === "review" && <p className="muted">참여 중인 프로젝트에서 검토를 기다리는 작업입니다.</p>}
    {error && <div className="row wrap" role="alert"><span className="error">{error}</span>
      <button onClick={() => setAttempt((value) => value + 1)}>다시 시도</button></div>}
    {!dashboard && !error && <p role="status">작업을 불러오는 중</p>}
    {dashboard?.tasks.length === 0 && <p className="empty muted">이 조건에 해당하는 작업이 없습니다.</p>}
    <ul className="resource-list">
      {dashboard?.tasks.map((task) => <li className="row spread wrap" key={task.id}>
        <div><Link className="resource-title" href={taskHref(task.project_id, task.id)}>{task.title}</Link>
          <div className="muted">{task.project_title}</div></div>
        <div className="row wrap"><StatusChip status={task.status} /><DueChip due={task.due_on} status={task.status} /></div>
      </li>)}
    </ul>
    {dashboard?.next_cursor && <button disabled={loadingMore} onClick={() => void loadMore()}>작업 더 보기</button>}
  </section>;
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
      <label>활동 종류 <select aria-label="활동 종류" value={type}
        onChange={(event) => router.push(pathname + (event.target.value ? "?type=" + event.target.value : ""))}>
        <option value="">전체</option><option value="media">음원</option><option value="version">버전</option>
        <option value="note">피드백</option><option value="reply">답글</option><option value="task">작업</option>
        <option value="membership">팀원</option><option value="invitation">초대</option><option value="project">프로젝트</option>
      </select></label>
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
    {error && <div className="row wrap" role="alert"><span className="error">{error}</span>
      <button onClick={() => { setError(""); setAttempt((value) => value + 1); }}>다시 시도</button></div>}
    {!events && !error && <p role="status">활동을 불러오는 중</p>}
    {events?.length === 0 && <p className="empty muted">이 조건에 해당하는 활동이 없습니다.</p>}
    {[...groups].map(([date, rows]) => <section className="activity-day" key={date}>
      <h3>{date}</h3>
      <ul className="clean-list">
        {rows.map((entry) => {
          const href = activityHref(projectId, entry);
          const label = actions[entry.action] ?? entry.action;
          const status = entry.detail.status;
          const actor = { name: entry.actor_name, email: entry.actor_id ? entry.actor : undefined };
          return <li className="row spread wrap activity-row" key={entry.id}>
            <span className="row wrap">
              {entry.actor_id ? <Avatar id={entry.actor_id} person={actor} /> : <span className="avatar avatar-md avatar-system" aria-hidden="true">♪</span>}
              <span className="activity-actor">{entry.actor_id ? displayName(actor) : entry.actor}</span>
              {href ? <Link href={href} className="resource-title">{label}</Link> : label}
              {typeof status === "string" && <StatusChip status={status} />}
            </span>
            <time className="muted" dateTime={entry.created_at}>{localTime.format(new Date(entry.created_at))}</time>
          </li>;
        })}
      </ul>
    </section>)}
    {more && <button disabled={busy} onClick={() => void loadMore()}>이전 활동 더 보기</button>}
  </>;
}
