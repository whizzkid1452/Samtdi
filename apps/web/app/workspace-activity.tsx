"use client";

import Link from "next/link";
import { taskHref } from "../lib/routes";
import { useEffect, useState } from "react";
import { api, describeError } from "../lib/api";

type Dashboard = {
  tasks: { id: string; project_id: string; project_title: string; title: string; status: string; due_on: string }[];
  review_count: number; due_soon_count: number; late_count: number;
};
type Activity = { id: string; action: string; subject_id: string; actor: string; detail: Record<string, unknown>; created_at: string };
const actions: Record<string, string> = {
  "project.created": "프로젝트 생성", "project.archived": "프로젝트 보관", "project.restored": "프로젝트 복원",
  "invitation.created": "팀원 초대", "invitation.accepted": "초대 수락", "membership.changed": "팀원 권한 변경",
  "media.created": "음원 추가", "media.archive_changed": "음원 보관 상태 변경",
  "version.queued": "버전 등록", "version.ready": "재생본 준비", "version.failed": "음원 처리 실패", "version.retried": "처리 재시도",
  "note.created": "노트 작성", "note.updated": "노트 변경", "reply.created": "답글 작성", "reply.updated": "답글 변경",
  "task.created": "카드 생성", "task.updated": "카드 변경", "task.unassigned": "담당자 해제",
};
const statuses: Record<string, string> = { todo: "할 일", progress: "진행 중", review: "검토 요청", done: "완료" };
const localTime = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul" });

export function DashboardPanel({ revision }: { revision: number }) {
  const [data, setData] = useState<Dashboard>();
  const [error, setError] = useState("");
  useEffect(() => {
    const request = new AbortController();
    api<Dashboard>("/v1/dashboard", { signal: request.signal }).then((value) => {
      if (!request.signal.aborted) { setData(value); setError(""); }
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [revision]);

  return <section className="panel" aria-label="내 작업">
    <h2>내 작업</h2>
    {error && <p role="alert" className="error">{error}</p>}
    {data && <>
      <div className="row wrap summary-counts">
        <span>검토 대기 <strong>{data.review_count}</strong></span>
        <span>7일 내 마감 <strong>{data.due_soon_count}</strong></span>
        <span>지연 <strong>{data.late_count}</strong></span>
      </div>
      {data.tasks.length === 0 ? <p className="muted">진행할 담당 작업이 없습니다.</p> :
        <ul className="clean-list">{data.tasks.map((task) => <li key={task.id} className="row spread wrap">
          <Link href={taskHref(task.project_id, task.id)}>{task.title}</Link>
          <span className="muted">{task.project_title} · {statuses[task.status]}{task.due_on ? " · " + task.due_on : ""}</span>
        </li>)}</ul>}
    </>}
  </section>;
}

export function ProjectActivity({ projectId, revision }: { projectId: string; revision: number }) {
  const [filter, setFilter] = useState("");
  const [events, setEvents] = useState<Activity[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const path = `/v1/projects/${projectId}/activity?type=${filter}`;

  useEffect(() => {
    const request = new AbortController();
    api<Activity[]>(path, { signal: request.signal }).then((value) => {
      if (!request.signal.aborted) { setEvents(value); setMore(value.length === 50); setError(""); }
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [path, revision]);

  return <details className="panel" open>
    <summary>프로젝트 활동</summary>
    <div className="row wrap">
      <label>활동 종류<select value={filter} onChange={(event) => setFilter(event.target.value)}>
        <option value="">전체</option><option value="version">버전</option><option value="note">노트</option>
        <option value="reply">답글</option><option value="task">작업 카드</option><option value="membership">팀원</option>
      </select></label>
      <span className="muted">한국 시간</span>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    <ul className="clean-list activity">{events.map((entry) => {
      const version = entry.action.startsWith("version.") ? entry.subject_id : entry.detail.version_id;
      const link = typeof version === "string" ? "/?" + new URLSearchParams({ project: projectId, version })
        : entry.action.startsWith("task.") ? "/?project=" + projectId + "#task-board" : undefined;
      return <li key={entry.id} className="row spread wrap">
        <span>{link ? <a href={link}>{actions[entry.action] ?? entry.action}</a> : actions[entry.action] ?? entry.action}
          {typeof entry.detail.status === "string" && " · " + (statuses[entry.detail.status] ?? entry.detail.status)}
          {" · "}{entry.actor}</span>
        <time className="muted" dateTime={entry.created_at}>{localTime.format(new Date(entry.created_at))}</time>
      </li>;
    })}</ul>
    {events.length === 0 && <p className="muted">이 조건에 해당하는 활동이 없습니다.</p>}
    {more && <button onClick={() => {
      const cursor = events.at(-1)?.id;
      if (!cursor) return;
      void api<Activity[]>(path + "&before=" + cursor).then((value) => {
        setEvents((previous) => [...previous, ...value.filter((entry) => !previous.some(({ id }) => id === entry.id))]);
        setMore(value.length === 50);
      }).catch((cause) => setError(describeError(cause)));
    }}>이전 활동 더 보기</button>}
  </details>;
}
