"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { displayName } from "../lib/people";
import { taskHref, versionLink } from "../lib/routes";
import { Avatar, CountBadge, Icon, Menu } from "./ui";

type Notification = components["schemas"]["Notification"];
type Inbox = components["schemas"]["Inbox"];
const sentAt = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Seoul" });

function describe(notice: Notification) {
  if (notice.action === "reply.created") return "새 답글";
  if (notice.action === "note.created") return "새 피드백";
  return "작업이 배정됐습니다";
}

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

  const reload = useCallback((open: boolean) => {
    if (open) void api<Inbox>("/v1/notifications").then(setInbox).catch((cause) => setError(describeError(cause)));
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

  return <Menu className="inbox" buttonClassName="inbox-button" onOpenChange={reload}
    label={<><Icon name="bell" size={18} /><span className="inbox-label">알림</span>
      {inbox.unread > 0 && <CountBadge value={inbox.unread} label={"읽지 않은 알림 " + inbox.unread + "개"} />}</>}>
    {(close) => <section className="inbox-body" aria-label="알림 목록">
      <div className="row spread inbox-header"><strong>알림</strong><span className="muted small">읽지 않음 {inbox.unread}</span></div>
      {error && <p role="alert" className="error">{error}</p>}
      {inbox.items.length === 0 && <p className="muted empty-note">받은 알림이 없습니다.</p>}
      <ul className="notice-list">{inbox.items.map((notice) => {
        const link = notice.version_id ? versionLink(notice.project_id, notice.version_id, notice.note_id)
          : taskHref(notice.project_id, notice.subject_id);
        const actor = { name: notice.actor_name, email: notice.actor_email };
        return <li key={notice.id} className={notice.read_at ? "" : "unread"}>
          {notice.actor_id ? <Avatar id={notice.actor_id} person={actor} /> : <span className="avatar avatar-md avatar-empty" aria-hidden="true" />}
          <div className="notice-body">
            <div className="row spread"><Link href={link} onNavigate={close}>{describe(notice)}</Link>
              {!notice.read_at && <button className="small-button" onClick={() => void markRead(notice.id)}>읽음</button>}</div>
            {notice.title && <p className="notice-title">{notice.title}</p>}
            <small className="muted">{notice.actor_id ? displayName(actor) + " · " : ""}{notice.project_title} · {sentAt.format(new Date(notice.created_at))}</small>
          </div>
        </li>;
      })}</ul>
      {inbox.items.length > 0 && inbox.items.length % 50 === 0 && <button onClick={() => {
        const id = inbox.items.at(-1)?.id;
        if (id) void api<Inbox>("/v1/notifications?before=" + id).then((next) => setInbox((old) => ({
          unread: next.unread, items: [...old.items, ...next.items.filter((item) => !old.items.some((entry) => entry.id === item.id))],
        }))).catch((cause) => setError(describeError(cause)));
      }}>이전 알림 더 보기</button>}
    </section>}
  </Menu>;
}
