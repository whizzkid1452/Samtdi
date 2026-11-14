"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../lib/api";
import { projectHref, versionLink } from "../lib/routes";
import { shortDate } from "../lib/tasks";
import { timecode } from "../lib/timecode";
import { useProjectMembers } from "./members";
import { taskFilters } from "./task-board";
import { Assignee, SourceChip } from "./task-card";
import { TaskEditor, type Task, type TaskChange } from "./task-editor";
import { DueChip, Icon, Menu, StatusChip } from "./ui";
import type { Project } from "./workspace";

const createdAt = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeZone: "Asia/Seoul" });

/** The task opened over its board or list, like an issue side panel. Closing returns to the same view and filters. */
export function TaskDetail({ project, taskId, onChanged }: { project: Project; taskId: string; onChanged?: () => void }) {
  const base = "/v1/projects/" + project.id;
  const router = useRouter();
  const { members, error: memberError } = useProjectMembers(project.id);
  const params = taskFilters(new URLSearchParams(useSearchParams()));
  const [task, setTask] = useState<Task>();
  const [change, setChange] = useState<TaskChange | null>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const canWrite = project.role !== "reviewer" && !project.archived_at;
  const back = projectHref(project.id, "tasks") + (params.size ? "?" + params : "");

  useEffect(() => {
    const request = new AbortController();

    api<Task>(base + "/tasks/" + encodeURIComponent(taskId), { signal: request.signal }).then((value) => {
      if (!request.signal.aborted) setTask(value);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [base, revision, taskId]);

  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [taskId, task?.id]);

  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open], .menu-popover")) return;
      router.push(back);
    }
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [back, router]);

  const nextStatus = task ? ({ todo: "progress", progress: "review", review: "done", done: "todo" } as const)[task.status] : undefined;
  const nextLabel = nextStatus ? ({ progress: "진행 시작", review: "검토 요청", done: "완료", todo: "다시 열기" } as const)[nextStatus] : undefined;

  return <aside className="side-panel" aria-label="작업 상세">
    <div className="side-panel-bar">
      <Link href={back} className="side-panel-close"><Icon name="close" />작업 목록</Link>
      {task && <span className="muted small">#{task.id.slice(0, 8)}</span>}
    </div>
    {(error || memberError) && <div role="alert" className="side-panel-body"><p className="error">{error || memberError}</p>
      <button onClick={() => { setError(""); setRevision((value) => value + 1); }}>다시 시도</button></div>}
    {!task && !error && <p role="status" className="side-panel-body">작업을 불러오는 중</p>}
    {task && <div className="side-panel-body">
      <StatusChip status={task.status} suffix={task.archived ? " · 보관됨" : ""} />
      <h2 className="section-title task-detail-title" ref={heading} tabIndex={-1}>{task.title}</h2>
      {canWrite && <div className="row wrap task-actions">
        {!task.archived && nextStatus && <button className="primary" onClick={() => setChange({ status: nextStatus })}>{nextLabel}</button>}
        {!task.archived && <button onClick={() => setChange(null)}>작업 편집</button>}
        <Menu buttonLabel="작업 관리" buttonClassName="icon-button" label={<Icon name="more" />}>{(close) => <div className="menu-list">
          <button className="menu-item" onClick={() => { close(); setChange({ archived: !task.archived }); }}>{task.archived ? "작업 복원" : "작업 보관"}</button>
        </div>}</Menu>
      </div>}
      <dl className="task-metadata">
        <div><dt>담당자</dt><dd><Assignee members={members} id={task.assignee_id} /></dd></div>
        <div><dt>일정</dt><dd className="row wrap schedule">{task.start_on && <span>{shortDate(task.start_on)} 시작</span>}
          <DueChip due={task.due_on} status={task.status} empty={task.start_on ? "마감 없음" : "날짜 없음"} /></dd></div>
        <div><dt>만든 날</dt><dd>{createdAt.format(new Date(task.created_at))}</dd></div>
        {task.source && <div className="task-metadata-wide"><dt>원본 피드백</dt><dd><SourceChip projectId={project.id} source={task.source} filename /></dd></div>}
      </dl>
      {task.description && <p className="message-body">{task.description}</p>}
      <h3 className="detail-heading">연결한 피드백 <span className="lane-count">{task.notes.length}</span></h3>
      {task.notes.length === 0 && <p className="muted">연결된 피드백이 없습니다.</p>}
      {task.notes.length > 0 && <ul className="linked-notes">
        {task.notes.map((note) => <li key={note.id}>
          <Link href={versionLink(project.id, note.version_id, note.id, note.start_ms)}>
            <span className="time-chip">{timecode(note.start_ms)}{note.end_ms != null && " ~ " + timecode(note.end_ms)}</span>
            <span className="linked-note-body">{note.deleted ? "삭제된 피드백" : note.body}</span>
          </Link>
          {note.resolved && <span className="status-label status-resolved"><Icon name="check" size={12} />해결됨</span>}
        </li>)}
      </ul>}
      {(task.result_version_id || task.review_text) && <section className="review-result">
        <h3 className="detail-heading">검토 결과</h3>
        {task.result_version_id && <Link className="button" href={versionLink(project.id, task.result_version_id)}><Icon name="play" size={14} />결과 버전 열기</Link>}
        {task.review_text && <p className="message-body">{task.review_text}</p>}
      </section>}
      {change !== undefined && canWrite && <TaskEditor base={base} members={members} task={task} change={change ?? undefined}
        close={() => setChange(undefined)} saved={() => { setChange(undefined); setRevision((value) => value + 1); onChanged?.(); }} />}
    </div>}
  </aside>;
}
