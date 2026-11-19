"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { Dialog } from "./dialog";
import { AppModal } from "./app-modal";
import { ConfirmAction, type Confirmation } from "./confirm-action";
import { useWorkspace, type Project, type TeamWorkspace } from "./workspace";

type TeamMember = components["schemas"]["WorkspaceMember"];

export function WorkspacePicker({ selected, onSelect }: { selected: string; onSelect: (id: string) => void }) {
  const { teams, teamsEnabled, refreshTeams } = useWorkspace();
  const [creating, setCreating] = useState<{ id: string; name: string }>();
  const [managing, setManaging] = useState<TeamWorkspace>();
  const current = teams.find(({ id }) => id === selected);
  if (!teamsEnabled) return null;

  return <section className="panel" aria-label="작업공간">
    <div className="row spread wrap">
      <label>작업공간 <select value={selected} onChange={(event) => onSelect(event.target.value)}>
        <option value="">전체 작업공간</option>
        {teams.filter(({ active }) => active).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
        <option value="shared">공유 프로젝트</option>
      </select></label>
      <div className="row wrap">
        {current?.owner && <button onClick={() => setManaging(current)}>멤버 관리</button>}
        <button onClick={() => setCreating({ id: crypto.randomUUID(), name: "" })}>새 작업공간</button>
      </div>
    </div>
    {teams.length === 0 && <p className="muted">내 작업실이나 팀 작업공간을 만들고 프로젝트를 추가하세요.</p>}
    {teams.filter(({ active }) => !active).map((team) => <p key={team.id} className="row wrap">
      <span>{team.name} · 준비 중</span><button onClick={() => setCreating(team)}>준비 이어가기</button>
    </p>)}
    {creating && <CreateWorkspace key={creating.id} initial={creating} close={() => setCreating(undefined)} saved={async (id) => {
      await refreshTeams();
      setCreating(undefined);
      onSelect(id);
    }} />}
    {managing && <WorkspaceMembers team={managing} close={() => setManaging(undefined)} />}
  </section>;
}

function CreateWorkspace({ initial, close, saved }: {
  initial: { id: string; name: string }; close: () => void; saved: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(Boolean(initial.name));
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setAttempted(true);
    setError("");
    try {
      const team = await api<TeamWorkspace>("/v1/workspaces", { method: "POST", body: JSON.stringify({ id: initial.id, name }) });
      await saved(team.id);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title="새 작업공간" close={() => { if (!busy) close(); }}>
    <form onSubmit={submit}>
      <label>작업공간 이름<input value={name} required maxLength={100} disabled={attempted} onChange={(event) => setName(event.target.value)} placeholder="내 작업실, 밴드, 스튜디오" /></label>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? "작업공간 준비 중" : attempted ? "같은 작업공간으로 이어가기" : "작업공간 만들기"}</button>
    </form>
  </Dialog>;
}

function WorkspaceMembers({ team, close }: { team: TeamWorkspace; close: () => void }) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [page, setPage] = useState(1);
  const [loadedPage, setLoadedPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [more, setMore] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const emailInput = useRef<HTMLInputElement>(null);
  const base = "/v1/workspaces/" + team.id + "/members";

  useEffect(() => {
    const request = new AbortController();
    api<TeamMember[]>(base + "?page=" + page, { signal: request.signal }).then((rows) => {
      if (request.signal.aborted) return;
      setMembers((previous) => page === 1 ? rows : [...previous, ...rows.filter((row) => !previous.some(({ id }) => id === row.id))]);
      setMore(rows.length === 100);
      setLoadedPage(page);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [base, page, revision]);

  async function changeMember({ subject }: { subject?: string } = {}) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(base + (subject ? "/" + encodeURIComponent(subject) : ""), {
        method: subject ? "DELETE" : "POST", body: subject ? undefined : JSON.stringify({ email }),
      });
      setEmail("");
      setPage(1);
      setRevision((value) => value + 1);
      return true;
    } catch (cause) {
      setError(describeError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return <>
    <AppModal title={team.name + " 멤버 관리"} close={close} busy={busy} suspended={!!confirmation}>
      <p className="muted">가입한 계정을 팀에 추가합니다. 프로젝트 참여는 프로젝트 설정에서 따로 초대하세요.</p>
      <form className="row wrap" onSubmit={(event) => { event.preventDefault(); void changeMember(); }}>
        <label>계정 이메일<input ref={emailInput} data-autofocus type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <button disabled={busy}>팀원 추가</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      <ul className="clean-list member-list">{members.map((member) => {
        const owner = member.organizationRoles.some(({ name }) => name === "samtdi-owner");
        return <li key={member.id} className="row spread wrap">
          <span>{member.name || member.primaryEmail} {owner && "· 소유자"}</span>
          {!owner && <button disabled={busy} onClick={(event) => setConfirmation({
            title: "작업공간 접근 해제",
            description: (member.name || member.primaryEmail) + "의 작업공간 접근을 해제할까요?",
            label: "제거",
            trigger: event.currentTarget,
            focusAfterSuccess: emailInput.current,
            run: () => changeMember({ subject: member.id }),
          })}>팀에서 제거</button>}
        </li>;
      })}</ul>
      {more && <button disabled={busy || loadedPage !== page} onClick={() => setPage((value) => value + 1)}>멤버 더 보기</button>}
    </AppModal>
    {confirmation && <ConfirmAction confirmation={confirmation} actionError={error} close={() => setConfirmation(undefined)} />}
  </>;
}

export function ProjectWorkspaceLink({ project }: { project: Project }) {
  const { teams, teamsEnabled, refreshProjects } = useWorkspace();
  const [destination, setDestination] = useState(project.workspace_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!teamsEnabled || project.role !== "owner") return null;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/v1/projects/" + project.id + "/workspace", { method: "PUT", body: JSON.stringify({ workspace_id: destination }) });
      await refreshProjects();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel" aria-label="프로젝트 작업공간">
    <h2>작업공간</h2>
    <p className="muted">현재 프로젝트의 멤버가 모두 참여한 작업공간으로 옮길 수 있습니다.</p>
    <form className="row wrap" onSubmit={save}>
      <label>대상 작업공간<select required value={destination} onChange={(event) => setDestination(event.target.value)}>
        <option value="">선택해 주세요</option>
        {teams.filter(({ active, owner }) => active && owner).map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <button disabled={busy || destination === project.workspace_id}>작업공간에 연결</button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
