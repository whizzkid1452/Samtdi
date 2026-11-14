"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { displayName } from "../lib/people";
import { Notifications } from "./notifications";
import { Avatar, Icon, Menu } from "./ui";
import { UploadProvider } from "./upload";

type Session = components["schemas"]["Session"];
export type Project = components["schemas"]["Project"] & { archived_at?: string };
export type Member = components["schemas"]["Member"];

const WorkspaceContext = createContext<{
  session: Session;
  projects: Project[];
  refreshProjects: () => Promise<void>;
  setSession: (session: Session) => void;
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
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    async function load() {
      try {
        const account = await api<Session>("/v1/me", { signal: request.signal });
        const visible = await api<Project[]>("/v1/projects", { signal: request.signal });
        if (request.signal.aborted) return;

        setProjects(visible);
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

  return <WorkspaceContext.Provider value={{ session, projects, refreshProjects, setSession }}>
    <UploadProvider key={session.account_id} accountId={session.account_id}>
    <header className="topbar">
      <div className="row topbar-start">
        <Link href="/work" className="brand"><span className="brand-mark" aria-hidden="true"><Icon name="music" size={16} /></span>사맛디</Link>
        <nav className="top-links" aria-label="주 메뉴">
          <Link href="/work" aria-current={pathname === "/work" ? "page" : undefined}>내 대시보드</Link>
          <Link href="/projects" aria-current={pathname.startsWith("/projects") ? "page" : undefined}>프로젝트</Link>
        </nav>
      </div>
      <div className="row topbar-end">
        <Notifications />
        <Menu buttonLabel={"계정: " + displayName(session)} buttonClassName="account-button" label={<>
          <Avatar id={session.account_id} person={session} size="md" />
          <span className="account-name">{displayName(session)}</span>
        </>}>{(close) => <AccountPanel session={session} busy={loggingOut} logout={() => { close(); void logout(); }} />}</Menu>
      </div>
    </header>
    {error && <p className="error main-content" role="alert">{error}</p>}
    {children}
    </UploadProvider>
  </WorkspaceContext.Provider>;
}

function AccountPanel({ session, busy, logout }: { session: Session; busy: boolean; logout: () => void }) {
  const { setSession } = useWorkspace();
  const [name, setName] = useState(session.name);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      setSession(await api<Session>("/v1/me", { method: "PATCH", body: JSON.stringify({ name }) }));
      setMessage("표시 이름을 저장했습니다.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return <section className="account-panel" aria-label="계정">
    <div className="row">
      <Avatar id={session.account_id} person={{ ...session, name }} size="lg" />
      <div className="account-identity"><strong>{displayName({ ...session, name })}</strong><span className="muted">{session.email}</span></div>
    </div>
    <form className="account-form" onSubmit={save}>
      <label>표시 이름<input value={name} maxLength={40} placeholder={session.email.split("@")[0]} onChange={(event) => setName(event.target.value)} /></label>
      <button disabled={saving || name.trim() === session.name}>저장</button>
    </form>
    <p className="muted small">팀원에게 아바타와 함께 보이는 이름입니다. 비워 두면 이메일 앞부분을 사용합니다.</p>
    {message && <p role="status" className="small">{message}</p>}
    {error && <p role="alert" className="error small">{error}</p>}
    <button className="menu-item" disabled={busy} onClick={logout}><Icon name="logout" />로그아웃</button>
  </section>;
}
