"use client";

import { Badge, Button, Popover } from "@mantine/core";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "../lib/api";
import { taskHref, versionLink } from "../lib/routes";

type Notification = {
  id: string;
  project_id: string;
  project_title: string;
  action: string;
  subject_id: string;
  version_id?: string;
  note_id?: string;
  read_at?: string;
};
type Inbox = { items: Notification[]; unread: number };

export function Notifications() {
  const [opened, setOpened] = useState(false);
  const [inbox, setInbox] = useState<Inbox>({ items: [], unread: 0 });
  const [error, setError] = useState("");
  const [loadingPage, setLoadingPage] = useState(false);
  const pendingRefresh = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    pendingRefresh.current?.abort();
    const request = new AbortController();
    pendingRefresh.current = request;

    return api<Inbox>("/v1/notifications", { signal: request.signal }).then((result) => {
      if (request.signal.aborted) return;

      setInbox(result);
      setError("");
    }).catch((cause) => {
      if (!request.signal.aborted) setError(describeError(cause));
    });
  }, []);

  useEffect(() => {
    function onWindowFocus() {
      void refresh();
    }

    void refresh();
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      pendingRefresh.current?.abort();
    };
  }, [refresh]);

  function changeOpened(value: boolean) {
    setOpened(value);
    if (value) void refresh();
  }

  async function markRead(id: string) {
    try {
      await api("/v1/notifications/" + id + "/read", { method: "POST" });
      await refresh();
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function loadMore() {
    const id = inbox.items.at(-1)?.id;
    if (!id || loadingPage) return;

    setLoadingPage(true);
    try {
      const next = await api<Inbox>("/v1/notifications?" + new URLSearchParams({ before: id }));
      setInbox((old) => old.items.at(-1)?.id === id ? {
        unread: next.unread,
        items: [...old.items, ...next.items.filter((item) => !old.items.some((entry) => entry.id === item.id))],
      } : old);
      setError("");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoadingPage(false);
    }
  }

  return (
    <Popover opened={opened} onChange={changeOpened} onDismiss={() => setOpened(false)}
      trapFocus returnFocus position="bottom-end" width="min(22rem, calc(100vw - 2rem))" shadow="sm">
      <Popover.Target>
        <Button variant="subtle" size="sm" onClick={() => changeOpened(!opened)} rightSection={inbox.unread > 0 && <Badge size="sm">{inbox.unread}</Badge>}>
          알림
        </Button>
      </Popover.Target>
      <Popover.Dropdown className="notification-popover">
        <section aria-label="알림 목록">
          {error && <p role="alert" className="error">{error}</p>}
          {inbox.items.length === 0 && <p className="muted">받은 알림이 없습니다.</p>}
          <ul className="clean-list">
            {inbox.items.map((notice) => {
              const href = notice.version_id ? versionLink(notice.project_id, notice.version_id, notice.note_id)
                : taskHref(notice.project_id, notice.subject_id);

              return (
                <li key={notice.id}>
                  <div className="row spread">
                    <Link href={href} onNavigate={() => setOpened(false)}>
                      {notice.action === "reply.created" ? "새 답글" : "작업이 배정됐습니다"}
                    </Link>
                    {!notice.read_at && <Button variant="default" size="compact-sm" onClick={() => void markRead(notice.id)}>읽음</Button>}
                  </div>
                  <small className="muted">{notice.project_title}</small>
                </li>
              );
            })}
          </ul>
          {inbox.items.length > 0 && inbox.items.length % 50 === 0 && (
            <Button variant="default" size="compact-sm" loading={loadingPage} onClick={() => void loadMore()}>이전 알림 더 보기</Button>
          )}
        </section>
      </Popover.Dropdown>
    </Popover>
  );
}
