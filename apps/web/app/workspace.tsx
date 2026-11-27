"use client";

import { BrandWordmark } from "./brand-wordmark";
import { Avatar, Button, Drawer, Popover } from "@mantine/core";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, describeError } from "../lib/api";
import { clearIdentitySession } from "../lib/supabase-identity";
import type { components } from "../lib/api-types";
import { projectHref } from "../lib/routes";
import { displayName, initials } from "../lib/people";
import { AccountProfile } from "./account-profile";
import { Notifications } from "./notifications";
import { WorkspacePicker } from "./workspace-manager";
import { UploadProvider } from "./upload";

type Session = components["schemas"]["Session"];
export type Project = components["schemas"]["Project"] & { archived_at?: string };
export type Member = { account_id: string; email: string; name?: string; role: Project["role"] };
export type TeamWorkspace = components["schemas"]["TeamWorkspace"];

type WorkspacesResponse = components["schemas"]["WorkspacesResponse"];

const WorkspaceContext = createContext<{
  session: Session;
  projects: Project[];
  refreshProjects: () => Promise<void>;
  teams: TeamWorkspace[];
  teamsEnabled: boolean;
  joinByCode: boolean;
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
  const isInvitation = pathname.startsWith("/invite/");
  const router = useRouter();
  const [session, setSession] = useState<Session | null>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [teams, setTeams] = useState<TeamWorkspace[]>([]);
  const [teamsEnabled, setTeamsEnabled] = useState(false);
  const [joinByCode, setJoinByCode] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [publicSignup, setPublicSignup] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [accountOpened, setAccountOpened] = useState(false);
  const [navigationOpened, setNavigationOpened] = useState(false);

  useEffect(() => {
    if (isInvitation) return;

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
        setJoinByCode(spaces.join_by_code === true);
        setSession(account);
      } catch (cause) {
        if (request.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) {
          setSession(null);
          try {
            const options = await api<components["schemas"]["WebAuthOptions"]>("/v1/auth/options", { signal: request.signal });
            if (!request.signal.aborted) setPublicSignup(options.public_signup);
          } catch (error) {
            if (!request.signal.aborted) setError(describeError(error));
          }
        } else setError(describeError(cause));
      }
    }

    void load();
    return () => request.abort();
  }, [attempt, isInvitation]);

  async function refreshProjects() {
    setProjects(await api<Project[]>("/v1/projects"));
  }

  async function refreshTeams() {
    const spaces = await api<WorkspacesResponse>("/v1/workspaces");
    setTeams(spaces.workspaces);
    setTeamsEnabled(spaces.enabled);
    setJoinByCode(spaces.join_by_code === true);
    await refreshProjects();
  }

  async function logout() {
    setLoggingOut(true);
    setError("");
    try {
      await api("/v1/auth/logout", { method: "POST" });
      await clearIdentitySession().catch(() => undefined);
      setSession(null);
      setProjects([]);
      router.replace("/projects");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoggingOut(false);
    }
  }

  if (isInvitation) return children;

  if (!session) {
    const target = pathname + (query.size ? "?" + query.toString() : "");
    const login = "/v1/auth/login?" + new URLSearchParams({ return_to: target });

    return <main className="login">
      <div className="login-content">
        <p><Link href="/projects" className="brand" aria-label="사맛디 홈"><BrandMark /><BrandWordmark /></Link></p>
        <h1>음악을 함께 완성하는 공간</h1>
        <p className="muted">{publicSignup ? "누구나 가입해 내 작업실을 쓸 수 있어요. 팀에 참여하려면 초대 코드가 필요해요." :
          "초대받은 프로젝트에 로그인해 작업을 이어가세요."}</p>
        {session === null ? <Button component="a" className="login-action" href={login} onClick={(event) => {
          if (window.location.hash) event.currentTarget.href = "/v1/auth/login?" + new URLSearchParams({ return_to: target + window.location.hash });
        }}>로그인</Button> : error ? <>
          <p role="alert">{error}</p>
          <button onClick={() => { setError(""); setAttempt((value) => value + 1); }}>다시 시도</button>
        </> : <p role="status">로그인 상태 확인 중</p>}
        {session === null && error && <p role="alert">{error}</p>}
        {session === null && publicSignup && <p><a href="/v1/auth/signup?return_to=%2Fprojects" onClick={() => { sessionStorage.setItem("samtdi:signup-intent", "1"); }}>사맛디 계정 만들기</a></p>}
      </div>
      <div className="login-art" aria-hidden="true"><BrandMark /></div>
    </main>;
  }

  const project = projects.find(({ id }) => pathname.split("/")[2] === id);
  const workspace = query.get("workspace") || project?.workspace_id || "";

  function selectWorkspace(id: string) {
    const filter = id ? "?" + new URLSearchParams({ workspace: id }) : "";
    router.push("/projects" + filter);
    setNavigationOpened(false);
  }

  const navigation = { pathname, projectId: project?.id, projects, workspace, selectWorkspace };

  return <WorkspaceContext.Provider value={{ session, projects, refreshProjects, teams, teamsEnabled, joinByCode, refreshTeams }}>
    <UploadProvider key={session.account_id} accountId={session.account_id}>
    <div className="workspace-shell">
      <aside className="workspace-sidebar">
        <WorkspaceNavigation {...navigation} />
      </aside>
      <div className="workspace-content">
    <header className="topbar">
      <div className="row">
        <Button className="mobile-navigation-trigger" variant="default" size="compact-sm" onClick={() => setNavigationOpened(true)}>메뉴</Button>
        <nav aria-label="현재 위치" className="row wrap workspace-breadcrumb">
          {pathname === "/work" ? <span aria-current="page">내 작업</span> :
            <Link href="/projects" aria-current={!project ? "page" : undefined}>프로젝트</Link>}
          {project && <><span aria-hidden="true">›</span><span aria-current="page">{project.title}</span></>}
        </nav>
      </div>
      <div className="row">
        <Notifications />
        <Popover opened={accountOpened} onChange={setAccountOpened} trapFocus returnFocus position="bottom-end"
          width="min(19rem, calc(100vw - 2rem))" shadow="sm">
          <Popover.Target>
            <Button variant="subtle" size="sm" aria-label="계정" onClick={() => setAccountOpened(!accountOpened)}
              leftSection={<Avatar size={24} color="samtdi">{initials(session)}</Avatar>}>
              {displayName(session)}
            </Button>
          </Popover.Target>
          <Popover.Dropdown>
            <p className="account-email muted">{session.email}</p>
            <Button variant="subtle" onClick={() => { setAccountOpened(false); setEditingProfile(true); }}>표시 이름 변경</Button>
            <p><a href="/third-party-notices.txt">오픈소스 고지</a></p>
            <Button variant="default" loading={loggingOut} onClick={() => void logout()}>로그아웃</Button>
          </Popover.Dropdown>
        </Popover>
      </div>
    </header>
    {error && <p className="error main-content" role="alert">{error}</p>}
    {editingProfile && <AccountProfile name={session.name ?? ""} close={() => setEditingProfile(false)}
      saved={(updated) => { setSession(updated); setEditingProfile(false); }} />}
    {children}
      </div>
    </div>
    <Drawer opened={navigationOpened} onClose={() => setNavigationOpened(false)} title="작업공간 메뉴" size="xs">
      <WorkspaceNavigation {...navigation} close={() => setNavigationOpened(false)} />
    </Drawer>
    </UploadProvider>
  </WorkspaceContext.Provider>;
}


function WorkspaceNavigation({ pathname, projectId, projects, workspace, selectWorkspace, close }: {
  pathname: string;
  projectId?: string;
  projects: Project[];
  workspace: string;
  selectWorkspace: (id: string) => void;
  close?: () => void;
}) {
  const shortcuts = projects.filter((project) => !project.archived_at && (
    !workspace || (workspace === "shared" ? !project.workspace_id : project.workspace_id === workspace)
  )).sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? "")).slice(0, 6);

  return <nav className="workspace-navigation" aria-label="주 메뉴">
    <Link href="/projects" className="brand" aria-label="사맛디 홈" onClick={close}><BrandMark /><BrandWordmark /></Link>
    <WorkspacePicker selected={workspace} onSelect={selectWorkspace} />
    <Link className="workspace-link" href="/projects" aria-current={pathname === "/projects" ? "page" : undefined} onClick={close}>프로젝트</Link>
    <Link className="workspace-link" href="/work" aria-current={pathname === "/work" ? "page" : undefined} onClick={close}>내 작업</Link>
    {shortcuts.length > 0 && <section aria-label="프로젝트 바로가기">
      <h2>프로젝트 바로가기</h2>
      <ul className="clean-list">
        {shortcuts.map((project) => <li key={project.id}>
          <Link className="workspace-link" href={projectHref(project.id)} onClick={close}
            aria-current={project.id === projectId ? "page" : undefined}>{project.title}</Link>
        </li>)}
      </ul>
    </section>}
  </nav>;
}

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>;
}
