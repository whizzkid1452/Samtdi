"use client";

import { useEffect, useState } from "react";
import { api, describeError } from "../lib/api";
import type { Member } from "./workspace";

/** Members of one project, loaded once per project and shared by headers, boards and editors. */
export function useProjectMembers(projectId: string) {
  const [state, setState] = useState<{ projectId: string; members: Member[]; error: string }>();

  useEffect(() => {
    const request = new AbortController();
    api<Member[]>("/v1/projects/" + encodeURIComponent(projectId) + "/members", { signal: request.signal })
      .then((members) => { if (!request.signal.aborted) setState({ projectId, members, error: "" }); })
      .catch((cause) => { if (!request.signal.aborted) setState({ projectId, members: [], error: describeError(cause) }); });
    return () => request.abort();
  }, [projectId]);

  const current = state?.projectId === projectId ? state : undefined;
  return { members: current?.members ?? [], loaded: !!current, error: current?.error ?? "" };
}
