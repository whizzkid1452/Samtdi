"use client";

import { Button, Checkbox, Popover, Select, TextInput } from "@mantine/core";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import { projectHref, type ProjectTab } from "../lib/routes";
import { MediaDetail, MediaLibrary } from "./media-library";
import { ConfirmAction, type Confirmation } from "./confirm-action";
import { ProjectMembers } from "./project-members";
import { TaskBoard, TaskDetail } from "./task-board";
import { ProjectActivity } from "./workspace-activity";
import { useWorkspace, type Project } from "./workspace";
import { ProjectWorkspaceLink, WorkspacePicker } from "./workspace-manager";

const tabs = [
  ["media", "음원"], ["tasks", "작업"], ["activity", "활동"], ["settings", "설정"],
] as const;

export function ProjectIndex() {
  const { projects, refreshProjects, teams, teamsEnabled } = useWorkspace();
  const router = useRouter();
  const query = useSearchParams();
  const selectedWorkspace = query.get("workspace") ?? "";
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const availableTeams = teams.filter(({ active, can_create }) => active && can_create);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const visible = projects.filter((project) => (!selectedWorkspace || (selectedWorkspace === "shared" ? !project.workspace_id : project.workspace_id === selectedWorkspace)) && Boolean(project.archived_at) === showArchived && project.title.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""));

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = form.get("title");
    const workspace_id = form.get("workspace_id") ?? undefined;

    setSaving(true);
    setError("");
    try {
      const created = await api<Project>("/v1/projects", { method: "POST", body: JSON.stringify({ title, workspace_id }) });
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
      {!creating && <Button disabled={teamsEnabled && !availableTeams.length} onClick={() => setCreating(true)}>새 프로젝트</Button>}
    </div>
    <WorkspacePicker selected={selectedWorkspace} onSelect={(id) => router.replace("/projects" + (id ? "?" + new URLSearchParams({ workspace: id }) : ""))} />
    {creating && <form className="panel row wrap" onSubmit={createProject}>
      <TextInput label="프로젝트 이름" name="title" maxLength={160} required />
      {teamsEnabled && <Select label="작업공간" name="workspace_id" searchable required allowDeselect={false}
        defaultValue={availableTeams.find(({ id }) => id === selectedWorkspace)?.id ?? availableTeams[0]?.id}
        data={availableTeams.map(({ id, name }) => ({ value: id, label: name }))} />}
      <Button type="submit" loading={saving}>프로젝트 만들기</Button>
      <Button type="button" variant="default" disabled={saving} onClick={() => setCreating(false)}>취소</Button>
    </form>}
    {error && <p role="alert" className="error">{error}</p>}
    {projects.length > 0 && <div className="row wrap filter-bar">
      <TextInput type="search" aria-label="프로젝트 검색" placeholder="프로젝트 검색" value={search}
        onChange={(event) => setSearch(event.target.value)} />
      {projects.some((project) => project.archived_at) && (
        <Checkbox label="보관된 프로젝트" checked={showArchived} onChange={(event) => setShowArchived(event.currentTarget.checked)} />
      )}
    </div>}
    <ul className="resource-list">
      {visible.map((project) => <li className="row spread wrap" key={project.id}>
        <Link className="resource-title" href={projectHref(project.id)}>{project.title}</Link>
        <div className="row wrap muted">
          {project.updated_at && <time dateTime={project.updated_at}>{new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeZone: "Asia/Seoul" }).format(new Date(project.updated_at))}</time>}
          <span className="status-label">{{owner: "소유자", editor: "편집자", reviewer: "검토자"}[project.role]}{project.archived_at ? " · 보관됨" : ""}</span>
        </div>
      </li>)}
    </ul>
    {visible.length === 0 && <p className="muted">{search || showArchived ? "조건에 맞는 프로젝트가 없습니다." : "새 프로젝트를 만들어 음원을 공유하세요."}</p>}
  </main>;
}

function ProjectSwitcher({ projects, projectId, tab }: { projects: Project[]; projectId: string; tab: ProjectTab }) {
  const [opened, setOpened] = useState(false);
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase("ko-KR");
  const visible = projects.filter(({ id, title, archived_at }) =>
    (!archived_at || id === projectId) && title.toLocaleLowerCase("ko-KR").includes(query));

  function changeOpened(value: boolean) {
    setOpened(value);
    if (!value) setSearch("");
  }

  return (
    <Popover opened={opened} onChange={changeOpened} onDismiss={() => changeOpened(false)}
      trapFocus returnFocus position="bottom-start" width="min(22rem, calc(100vw - 2rem))" shadow="sm">
      <Popover.Target><Button variant="default" size="sm" onClick={() => changeOpened(!opened)}>프로젝트 전환</Button></Popover.Target>
      <Popover.Dropdown>
        <TextInput aria-label="프로젝트 검색" placeholder="프로젝트 검색" data-autofocus value={search}
          onChange={(event) => setSearch(event.currentTarget.value)} />
        {visible.length === 0 && <p className="muted">일치하는 프로젝트가 없습니다.</p>}
        <ul className="clean-list project-switcher-list">
          {visible.map(({ id, title }) => (
            <li key={id}>
              <Link href={projectHref(id, tab)} aria-current={id === projectId ? "page" : undefined}
                onNavigate={() => changeOpened(false)}>{title}</Link>
            </li>
          ))}
        </ul>
      </Popover.Dropdown>
    </Popover>
  );
}

export function ProjectScreen({ projectId, tab, itemId, versionId, taskId }: { projectId: string; tab: ProjectTab; itemId?: string; versionId?: string; taskId?: string }) {
  const { projects, session } = useWorkspace();
  const query = useSearchParams();
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
          <ProjectSwitcher projects={projects} projectId={projectId} tab={tab} />
          <h1>{project.title}</h1>
          <span className="status-label">{project.archived_at ? "보관됨" : "비공개"}</span>
        </div>
        <nav className="project-tabs" aria-label="프로젝트 탭">
          {tabs.map(([value, label]) => (
            <Button component={Link} variant="subtle" radius={0} key={value} href={projectHref(projectId, value)}
              aria-current={tab === value ? "page" : undefined}>{label}</Button>
          ))}
        </nav>
      </div>
    </div>
    <main className="main-content">
      {project.archived_at && <p className="notice" role="status">보관된 프로젝트입니다. 기존 내용을 열 수 있습니다.</p>}
      {tab === "media" && (itemId ?
        <MediaDetail key={projectId + ":" + itemId + ":" + (versionId ?? "")} project={project} itemId={itemId} versionId={versionId}
          accountId={session.account_id} initialNote={query.get("note") ?? undefined} initialAt={at === null ? undefined : Number(at)} /> :
        <MediaLibrary key={projectId + ":" + query.toString()} project={project} />)}
      {tab === "tasks" && (taskId ? <TaskDetail key={projectId + ":" + taskId} project={project} taskId={taskId} /> :
        <TaskBoard key={projectId + ":" + query.toString()} project={project} initialNote={query.get("task_note") ?? undefined} />)}
      {tab === "activity" && <ProjectActivity key={projectId} projectId={projectId} />}
      {tab === "settings" && <ProjectSettings key={projectId} project={project} />}
    </main>
  </>;
}

function ProjectSettings({ project }: { project: Project }) {
  const { refreshProjects } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>();

  async function changeArchive(archived: boolean) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/v1/projects/" + project.id + "/archive", { method: "PATCH", body: JSON.stringify({ archived }) });
      await refreshProjects();
      setMessage(archived ? "프로젝트를 보관했습니다." : "프로젝트를 복원했습니다.");
      return true;
    } catch (cause) {
      setError(describeError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return <>
    <ProjectMembers project={project} />
    <ProjectWorkspaceLink key={project.id + ":" + project.workspace_id} project={project} />
    <section className="panel" aria-label="다운로드">
      <h2>다운로드</h2>
      <div className="row wrap">
        <Button component="a" variant="default" href={"/v1/projects/" + project.id + "/export/json"}>JSON 다운로드</Button>
        <Button component="a" variant="default" href={"/v1/projects/" + project.id + "/export/csv"}>CSV 다운로드</Button>
      </div>
    </section>
    {project.role === "owner" && <section className="panel">
      <h2>프로젝트 보관</h2>
      {error && <p role="alert" className="error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button disabled={busy} onClick={(event) => {
        const archived = !project.archived_at;
        const label = archived ? "보관" : "복원";
        setConfirmation({
          title: "프로젝트 " + label,
          description: project.title + " 프로젝트를 " + label + "할까요?",
          label,
          trigger: event.currentTarget,
          run: () => changeArchive(archived),
        });
      }}>{project.archived_at ? "프로젝트 복원" : "프로젝트 보관"}</button>
      {confirmation && <ConfirmAction confirmation={confirmation} actionError={error} close={() => setConfirmation(undefined)} />}
    </section>}
  </>;
}
