"use client";

import { useEffect, useState } from "react";
import { api, describeError } from "../lib/api";

type Notification = { id: string; project_id: string; project_title: string; action: string; version_id: string; note_id: string; read_at?: string };
type Inbox = { items: Notification[]; unread: number };

export function Notifications() {
  const [inbox, setInbox] = useState<Inbox>({ items: [], unread: 0 });
  const [error, setError] = useState("");

  useEffect(() => {
    const request = new AbortController();
    function refresh() {
      api<Inbox>("/v1/notifications", { signal: request.signal }).then((result) => {
        if (!request.signal.aborted) setInbox(result);
      }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    }
    refresh();
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); request.abort(); };
  }, []);

  async function markRead(id: string) {
    try {
      await api("/v1/notifications/" + id + "/read", { method: "POST" });
      setInbox(await api<Inbox>("/v1/notifications"));
      setError("");
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return <details className="inbox" onToggle={(event) => {
    if (event.currentTarget.open) void api<Inbox>("/v1/notifications").then(setInbox).catch((cause) => setError(describeError(cause)));
  }}>
    <summary>알림{inbox.unread > 0 && <strong> {inbox.unread}</strong>}</summary>
    <section className="inbox-body panel" aria-label="알림 목록">
      {error && <p role="alert" className="error">{error}</p>}
      {inbox.items.length === 0 && <p className="muted">받은 알림이 없습니다.</p>}
      <ul className="clean-list">{inbox.items.map((notice) => {
        const query = new URLSearchParams({ project: notice.project_id });
        if (notice.version_id) query.set("version", notice.version_id);
        if (notice.note_id) query.set("note", notice.note_id);
        const link = "/?" + query + (notice.version_id ? "#note-" + notice.note_id : "#task-board");
        return <li key={notice.id}>
          <div className="row spread"><a href={link}>{notice.action === "reply.created" ? "새 답글" : "작업이 배정됐습니다"}</a>
            {!notice.read_at && <button onClick={() => void markRead(notice.id)}>읽음</button>}</div>
          <small className="muted">{notice.project_title}</small>
        </li>;
      })}</ul>
      {inbox.items.length > 0 && inbox.items.length % 50 === 0 && <button onClick={() => {
        const id = inbox.items.at(-1)?.id;
        if (id) void api<Inbox>("/v1/notifications?before=" + id).then((next) => setInbox((old) => ({
          unread: next.unread, items: [...old.items, ...next.items.filter((item) => !old.items.some((entry) => entry.id === item.id))],
        }))).catch((cause) => setError(describeError(cause)));
      }}>이전 알림 더 보기</button>}
    </section>
  </details>;
}
