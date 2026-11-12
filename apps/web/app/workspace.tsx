"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { MediaLibrary } from "./media-library";
import { ProjectMembers } from "./project-members";

type Session = components["schemas"]["Session"];
export type Project = components["schemas"]["Project"] & { archived_at?: string };
export type Member = { account_id: string; email: string; role: Project["role"] };
type Location = { project?: string; version?: string; note?: string; at?: string };

export function Workspace({ initial }: { initial: Location }) {
  const [session, setSession] = useState<Session | null>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(initial.project ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = projects.find((project) => project.id === projectId);

  const reload = useCallback(async () => {
    const result = await api<Project[]>("/v1/projects");
    setProjects(result);
    setProjectId((selected) => result.some((project) => project.id === selected) ? selected : result[0]?.id ?? "");
  }, []);

  useEffect(() => {
    const request = new AbortController();
    async function load() {
      try {
        const account = await api<Session>("/v1/me", { signal: request.signal });
        if (request.signal.aborted) return;
        await reload();
        if (!request.signal.aborted) setSession(account);
      } catch (cause) {
        if (request.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) setSession(null);
        else setError(describeError(cause));
      }
    }
    void load();
    return () => request.abort();
  }, [reload]);

  async function run(change: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await change();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = String(new FormData(form).get("title"));
    await run(async () => {
      const project = await api<Project>("/v1/projects", { method: "POST", body: JSON.stringify({ title }) });
      await reload();
      setProjectId(project.id);
      form.reset();
    });
  }

  if (!session) {
    return (
      <main className="login">
        <div className="login-content">
          <p className="brand">사맛디</p>
          <h1>음악을 함께 완성하는 공간</h1>
          <p className="muted">초대받은 프로젝트에 로그인해 작업을 이어가세요.</p>
          {error && <p role="alert">{error}</p>}
          {session === null ? <a className="button primary" href="/v1/auth/login">로그인</a> : <p role="status">{error ? "" : "로그인 상태 확인 중"}</p>}
        </div>
      </main>
    );
  }

  return (
    <div className="workspace">
      <header className="topbar">
        <span className="brand">사맛디</span>
        <div className="row"><span className="muted">{session.email}</span><button onClick={() => void run(async () => {
          await api("/v1/auth/logout", { method: "POST" });
          setSession(null);
          setProjects([]);
        })}>로그아웃</button></div>
      </header>
      <div className="workspace-grid">
        <aside className="sidebar">
          <h2>프로젝트</h2>
          <nav aria-label="프로젝트">
            {projects.map((project) => <button key={project.id} aria-current={projectId === project.id ? "page" : undefined}
              onClick={() => setProjectId(project.id)}>{project.title}{project.archived_at ? " · 보관됨" : ""}</button>)}
          </nav>
          <form onSubmit={createProject}>
            <label htmlFor="project-title">새 프로젝트 이름</label>
            <input id="project-title" name="title" maxLength={160} required />
            <button className="primary" disabled={busy}>프로젝트 만들기</button>
          </form>
        </aside>
        <main className="main-content">
          {error && <p className="error" role="alert">{error}</p>}
          {current ? <>
            <div className="row spread">
              <h1>{current.title}</h1>
              {current.role === "owner" && <button disabled={busy} onClick={() => void run(async () => {
                await api(`/v1/projects/${current.id}/archive`, { method: "PATCH", body: JSON.stringify({ archived: !current.archived_at }) });
                await reload();
              })}>{current.archived_at ? "복원" : "보관"}</button>}
            </div>
            {current.archived_at && <p role="status">보관된 프로젝트입니다. 기존 내용을 열 수 있습니다.</p>}
            <MediaLibrary key={current.id} project={current} initialVersion={current.id === initial.project ? initial.version : undefined} initialAt={initial.at === undefined ? undefined : Number(initial.at)} />
            <ProjectMembers key={current.id} project={current} />
          </> : <div className="empty"><h1>프로젝트를 만들어 보세요</h1><p className="muted">프로젝트에서 팀원과 수정본을 공유할 수 있습니다.</p></div>}
        </main>
      </div>
    </div>
  );
}
