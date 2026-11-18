"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { Notifications } from "./notifications";
import { UploadProvider } from "./upload";

type Session = components["schemas"]["Session"];
export type Project = components["schemas"]["Project"] & { archived_at?: string };
export type Member = { account_id: string; email: string; role: Project["role"] };
export type TeamWorkspace = components["schemas"]["TeamWorkspace"];

type WorkspacesResponse = components["schemas"]["WorkspacesResponse"];

const WorkspaceContext = createContext<{
  session: Session;
  projects: Project[];
  refreshProjects: () => Promise<void>;
  teams: TeamWorkspace[];
  teamsEnabled: boolean;
  refreshTeams: () => Promise<void>;
} | null>(null);

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Workspace is unavailable");
  return context;
}

export function Workspace({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const query = useSearchParams();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [teams, setTeams] = useState<TeamWorkspace[]>([]);
  const [teamsEnabled, setTeamsEnabled] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    async function load() {
      try {
        const account = await api<Session>("/v1/me", { signal: request.signal });
        const visible = await api<Project[]>("/v1/projects", { signal: request.signal });
        const spaces = await api<WorkspacesResponse>("/v1/workspaces", { signal: request.signal });
        if (request.signal.aborted) return;

        setProjects(visible);
        setTeams(spaces.workspaces);
        setTeamsEnabled(spaces.enabled);
        setSession(account);
      } catch (cause) {
        if (request.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) setSession(null);
        else setError(describeError(cause));
      }
    }

    void load();
    return () => request.abort();
  }, [attempt]);

  async function refreshProjects() {
    setProjects(await api<Project[]>("/v1/projects"));
  }

  async function refreshTeams() {
    const spaces = await api<WorkspacesResponse>("/v1/workspaces");
    setTeams(spaces.workspaces);
    setTeamsEnabled(spaces.enabled);
    await refreshProjects();
  }

  async function logout() {
    setLoggingOut(true);
    setError("");
    try {
      await api("/v1/auth/logout", { method: "POST" });
      setSession(null);
      setProjects([]);
      router.replace("/projects");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoggingOut(false);
    }
  }

  if (!session) {
    const target = pathname + (query.size ? "?" + query.toString() : "");
    const login = "/v1/auth/login?" + new URLSearchParams({ return_to: target });

    return <main className="login">
      <div className="login-content">
        <p className="brand">사맛디</p>
        <h1>음악을 함께 완성하는 공간</h1>
        <p className="muted">초대받은 프로젝트에 로그인해 작업을 이어가세요.</p>
        {session === null ? <a className="button primary" href={login} onClick={(event) => {
          if (window.location.hash) event.currentTarget.href = "/v1/auth/login?" + new URLSearchParams({ return_to: target + window.location.hash });
        }}>로그인</a> : error ? <>
          <p role="alert">{error}</p>
          <button onClick={() => { setError(""); setAttempt((value) => value + 1); }}>다시 시도</button>
        </> : <p role="status">로그인 상태 확인 중</p>}
      </div>
    </main>;
  }

  return <WorkspaceContext.Provider value={{ session, projects, refreshProjects, teams, teamsEnabled, refreshTeams }}>
    <UploadProvider key={session.account_id} accountId={session.account_id}>
    <header className="topbar">
      <div className="row">
        <Link href="/projects" className="brand">사맛디</Link>
        <nav className="top-links" aria-label="주 메뉴">
          <Link href="/projects" aria-current={pathname === "/projects" ? "page" : undefined}>프로젝트</Link>
          <Link href="/work" aria-current={pathname === "/work" ? "page" : undefined}>내 작업</Link>
        </nav>
      </div>
      <div className="row">
        <Notifications />
        <details className="inbox">
          <summary className="account-label">계정</summary>
          <div className="inbox-body panel">
            <p className="muted">{session.email}</p>
            <p><a href="/third-party-notices.txt">오픈소스 고지</a></p>
            <button disabled={loggingOut} onClick={() => void logout()}>로그아웃</button>
          </div>
        </details>
      </div>
    </header>
    {error && <p className="error main-content" role="alert">{error}</p>}
    {children}
    </UploadProvider>
  </WorkspaceContext.Provider>;
}
