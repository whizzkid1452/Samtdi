"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, describeError } from "../lib/api";
import { projectHref, versionHref } from "../lib/routes";

export default function LegacyEntry() {
  const query = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState("");
  const projectId = query.get("project");
  const versionId = query.get("version");
  const noteId = query.get("note");
  const taskNote = query.get("task_note");
  const at = query.get("at");

  useEffect(() => {
    const request = new AbortController();

    async function redirectEntry() {
      if (!projectId) {
        router.replace("/projects");
        return;
      }
      if (taskNote || window.location.hash === "#task-board") {
        const suffix = taskNote ? "?" + new URLSearchParams({ task_note: taskNote }) : "";
        router.replace(projectHref(projectId, "tasks") + suffix);
        return;
      }
      if (!versionId) {
        router.replace(projectHref(projectId));
        return;
      }

      try {
        const version = await api<{ item_id: string }>(
          "/v1/projects/" + encodeURIComponent(projectId) + "/versions/" + encodeURIComponent(versionId),
          { signal: request.signal },
        );
        if (request.signal.aborted) return;

        router.replace(versionHref({
          projectId, itemId: version.item_id, versionId, noteId: noteId ?? undefined, at: at === null ? undefined : Number(at),
        }));
      } catch (cause) {
        if (!request.signal.aborted) setError(describeError(cause));
      }
    }

    void redirectEntry();
    return () => request.abort();
  }, [at, noteId, projectId, router, taskNote, versionId]);

  return <main className="main-content">
    {error ? <><p role="alert">{error}</p><Link href="/projects">프로젝트 목록</Link></> : <p role="status">화면을 여는 중</p>}
  </main>;
}
