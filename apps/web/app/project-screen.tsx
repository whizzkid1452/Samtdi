"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import { projectHref, type ProjectTab } from "../lib/routes";
import { MediaLibrary } from "./media-library";
import { ProjectMembers } from "./project-members";
import { TaskBoard } from "./task-board";
import { ProjectActivity } from "./workspace-activity";
import { useWorkspace, type Project } from "./workspace";

const tabs = [
  ["media", "음원"], ["tasks", "작업"], ["activity", "활동"], ["settings", "설정"],
] as const;

export function ProjectIndex() {
  const { projects, refreshProjects } = useWorkspace();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const visible = projects.filter((project) => project.title.toLowerCase().includes(search.trim().toLowerCase()));

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = new FormData(event.currentTarget).get("title");

    setSaving(true);
    setError("");
    try {
      const created = await api<Project>("/v1/projects", { method: "POST", body: JSON.stringify({ title }) });
      await refreshProjects();
      router.push(projectHref(created.id));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return <main className="main-content">
    <div className="row spread wrap section-header">
      <h1>프로젝트</h1>
      {!creating && <button className="primary" onClick={() => setCreating(true)}>새 프로젝트</button>}
    </div>
    {creating && <form className="panel row wrap" onSubmit={createProject}>
      <label htmlFor="project-title">프로젝트 이름</label>
      <input id="project-title" name="title" maxLength={160} required />
      <button className="primary" disabled={saving}>프로젝트 만들기</button>
      <button type="button" disabled={saving} onClick={() => setCreating(false)}>취소</button>
    </form>}
    {error && <p role="alert" className="error">{error}</p>}
    {projects.length > 0 && <input type="search" aria-label="프로젝트 검색" placeholder="프로젝트 검색" value={search}
      onChange={(event) => setSearch(event.target.value)} />}
    <ul className="resource-list">
      {visible.map((project) => <li className="row spread wrap" key={project.id}>
        <Link className="resource-title" href={projectHref(project.id)}>{project.title}</Link>
        <span className="muted">{{owner: "소유자", editor: "편집자", reviewer: "검토자"}[project.role]}
          {project.archived_at ? " · 보관됨" : ""}</span>
      </li>)}
    </ul>
    {visible.length === 0 && <p className="muted">{search ? "검색 결과가 없습니다." : "새 프로젝트를 만들어 음원을 공유하세요."}</p>}
  </main>;
}

export function ProjectScreen({ projectId, tab, versionId }: { projectId: string; tab: ProjectTab; versionId?: string }) {
  const { projects, session } = useWorkspace();
  const query = useSearchParams();
  const router = useRouter();
  const project = projects.find(({ id }) => id === projectId);
  const at = query.get("at");

  if (!project) return <main className="main-content">
    <h1>프로젝트를 열 수 없습니다</h1>
    <p className="muted">접근 권한이나 링크를 확인해 주세요.</p>
    <Link href="/projects">프로젝트 목록</Link>
  </main>;

  return <>
    <div className="project-header">
      <div className="project-header-inner">
        <div className="row wrap project-title">
          <select aria-label="프로젝트 선택" value={project.id}
            onChange={(event) => router.push(projectHref(event.target.value, tab))}>
            {projects.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
          </select>
          <h1>{project.title}</h1>
          <span className="status-label">{project.archived_at ? "보관됨" : "비공개"}</span>
        </div>
        <nav className="project-tabs" aria-label="프로젝트 탭">
          {tabs.map(([value, label]) => <Link key={value} href={projectHref(projectId, value)}
            aria-current={tab === value ? "page" : undefined}>{label}</Link>)}
        </nav>
      </div>
    </div>
    <main className="main-content">
      {project.archived_at && <p className="notice" role="status">보관된 프로젝트입니다. 기존 내용을 열 수 있습니다.</p>}
      {tab === "media" && <MediaLibrary key={projectId + ":" + (versionId ?? "")} project={project} accountId={session.account_id}
        initialVersion={versionId} initialNote={query.get("note") ?? undefined} initialAt={at === null ? undefined : Number(at)} />}
      {tab === "tasks" && <TaskBoard key={projectId} project={project} initialNote={query.get("task_note") ?? undefined} />}
      {tab === "activity" && <ProjectActivity key={projectId} projectId={projectId} revision={0} />}
      {tab === "settings" && <ProjectSettings key={projectId} project={project} />}
    </main>
  </>;
}

function ProjectSettings({ project }: { project: Project }) {
  const { refreshProjects } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function changeArchive() {
    const archived = !project.archived_at;
    if (!window.confirm(project.title + (archived ? " 프로젝트를 보관할까요?" : " 프로젝트를 복원할까요?"))) return;

    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/v1/projects/" + project.id + "/archive", { method: "PATCH", body: JSON.stringify({ archived }) });
      await refreshProjects();
      setMessage(archived ? "프로젝트를 보관했습니다." : "프로젝트를 복원했습니다.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <ProjectMembers project={project} />
    <section className="panel" aria-label="다운로드">
      <h2>다운로드</h2>
      <div className="row wrap">
        <a className="button" href={"/v1/projects/" + project.id + "/export/json"}>JSON 다운로드</a>
        <a className="button" href={"/v1/projects/" + project.id + "/export/csv"}>CSV 다운로드</a>
      </div>
    </section>
    {project.role === "owner" && <section className="panel">
      <h2>프로젝트 보관</h2>
      {error && <p role="alert" className="error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button disabled={busy} onClick={() => void changeArchive()}>{project.archived_at ? "프로젝트 복원" : "프로젝트 보관"}</button>
    </section>}
  </>;
}
