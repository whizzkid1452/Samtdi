"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../lib/api";
import { taskHref } from "../lib/routes";
import { TaskEditor, type Task, type TaskNote } from "./task-editor";
import { StatusChip } from "./ui";
import type { Member } from "./workspace";

const pageSize = 100;

export function ReviewTaskLinks({ projectId, note, canCreate, pause }: {
  projectId: string;
  note: TaskNote;
  canCreate: boolean;
  pause: () => void;
}) {
  const base = "/v1/projects/" + projectId;
  const url = base + "/tasks?note=" + encodeURIComponent(note.id);
  const [tasks, setTasks] = useState<Task[]>();
  const [members, setMembers] = useState<Member[]>();
  const [more, setMore] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const pageRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const request = new AbortController();

    api<Task[]>(url, { signal: request.signal }).then((rows) => {
      if (request.signal.aborted) return;

      setTasks(rows);
      setMore(rows.length === pageSize);
    }).catch((cause) => {
      if (!request.signal.aborted) setError(describeError(cause));
    });

    return () => {
      request.abort();
      pageRequest.current?.abort();
    };
  }, [url, revision]);

  useEffect(() => {
    if (!editing) return;

    const request = new AbortController();
    api<Member[]>(base + "/members", { signal: request.signal }).then((rows) => {
      if (!request.signal.aborted) setMembers(rows);
    }).catch((cause) => {
      if (request.signal.aborted) return;

      setError(describeError(cause));
      setEditing(false);
    });

    return () => request.abort();
  }, [base, editing]);

  async function loadMore() {
    const cursor = tasks?.at(-1)?.id;
    if (!cursor || pageRequest.current) return;

    const request = new AbortController();
    pageRequest.current = request;
    setLoading(true);
    setError("");
    try {
      const rows = await api<Task[]>(url + "&after=" + encodeURIComponent(cursor), { signal: request.signal });
      if (request.signal.aborted) return;

      setTasks((previous) => [...(previous ?? []), ...rows.filter(({ id }) => !previous?.some((task) => task.id === id))]);
      setMore(rows.length === pageSize);
    } catch (cause) {
      if (!request.signal.aborted) setError(describeError(cause));
    } finally {
      pageRequest.current = null;
      setLoading(false);
    }
  }

  return <div className="review-task-links">
    <strong>연결된 작업</strong>
    {tasks?.length === 0 && <p className="muted">연결된 작업이 없습니다.</p>}
    {!tasks && !error && <p className="muted" role="status">연결된 작업을 불러오는 중</p>}
    {tasks && tasks.length > 0 && <ul className="clean-list">
      {tasks.map((task) => <li className="row wrap" key={task.id}>
        <Link href={taskHref(projectId, task.id)}>{task.title}</Link>
        <StatusChip status={task.status} suffix={task.archived ? " · 보관됨" : ""} />
      </li>)}
    </ul>}
    {error && <div className="row wrap"><span className="error" role="alert">{error}</span>
      <button type="button" onClick={() => { setError(""); setRevision((value) => value + 1); }}>다시 시도</button>
    </div>}
    <div className="row wrap">
      {more && <button type="button" disabled={loading} onClick={() => void loadMore()}>연결 작업 더 보기</button>}
      {canCreate && <button type="button" disabled={editing && !members} onClick={() => {
        setError("");
        pause();
        setEditing(true);
      }}>작업 만들기</button>}
    </div>
    {editing && members && canCreate && <TaskEditor base={base} members={members} seedNote={note}
      close={() => setEditing(false)} saved={() => {
        setEditing(false);
        setRevision((value) => value + 1);
      }} />}
  </div>;
}
