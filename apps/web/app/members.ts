"use client";

import { useEffect, useState } from "react";
import { api, describeError } from "../lib/api";
import type { Member } from "./workspace";

export function useProjectMembers(projectId: string | undefined) {
  const [result, setResult] = useState<{ projectId: string; members: Member[]; error: string }>();

  useEffect(() => {
    if (!projectId) return;

    const request = new AbortController();
    api<Member[]>("/v1/projects/" + encodeURIComponent(projectId) + "/members", { signal: request.signal })
      .then((members) => {
        if (!request.signal.aborted) setResult({ projectId, members, error: "" });
      })
      .catch((cause) => {
        if (!request.signal.aborted) setResult({ projectId, members: [], error: describeError(cause) });
      });

    return () => request.abort();
  }, [projectId]);

  const current = result?.projectId === projectId ? result : undefined;
  return { members: current?.members ?? [], error: current?.error ?? "" };
}
