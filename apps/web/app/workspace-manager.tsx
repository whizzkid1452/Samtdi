"use client";

import { Button, Select, TextInput } from "@mantine/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { AppModal } from "./app-modal";
import { ConfirmAction, type Confirmation } from "./confirm-action";
import { useWorkspace, type Project, type TeamWorkspace } from "./workspace";
import { WorkspaceInvitations } from "./workspace-invitations";
import { InlineError } from "./request-states";

type TeamMember = components["schemas"]["WorkspaceMember"];

export function WorkspacePicker({ selected, onSelect }: { selected: string; onSelect: (id: string) => void }) {
  const { teams, teamsEnabled, joinByCode, refreshTeams } = useWorkspace();
  const [creating, setCreating] = useState<{ id: string; name: string }>();
  const [managing, setManaging] = useState<TeamWorkspace>();
  const [joining, setJoining] = useState(false);
  const current = teams.find(({ id }) => id === selected);
  if (!teamsEnabled) return null;

  return <section className="panel" aria-label="작업공간">
    <div className="row spread wrap">
      <Select label="작업공간" searchable allowDeselect={false} value={selected || "all"}
        data={[
          { value: "all", label: "전체 작업공간" },
          ...teams.filter(({ active }) => active).map(({ id, name }) => ({ value: id, label: name })),
          { value: "shared", label: "공유 프로젝트" },
        ]}
        onChange={(value) => onSelect(value === "all" ? "" : value ?? "")} />
      <div className="row wrap">
        {current?.owner && !current.personal && <Button variant="default" onClick={() => setManaging(current)}>멤버 관리</Button>}
        {joinByCode && <Button variant="default" onClick={() => setJoining(true)}>팀 참여</Button>}
        <Button variant="default" onClick={() => setCreating({ id: crypto.randomUUID(), name: "" })}>새 작업공간</Button>
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
    {managing && <WorkspaceMembers team={managing} codeOnly={joinByCode} close={() => setManaging(undefined)} />}
    {joining && <JoinWorkspace close={() => setJoining(false)} joined={async (id) => {
      await refreshTeams();
      setJoining(false);
      onSelect(id);
    }} />}
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

  return <AppModal title="새 작업공간" close={close} busy={busy}>
    <form onSubmit={submit}>
      <TextInput label="작업공간 이름" value={name} required data-autofocus maxLength={100} disabled={attempted}
        onChange={(event) => setName(event.currentTarget.value)} placeholder="내 작업실, 밴드, 스튜디오" />
      {error && <InlineError message={error} />}
      <Button mt="sm" type="submit" loading={busy}>{busy ? "작업공간 준비 중" : attempted ? "같은 작업공간으로 이어가기" : "작업공간 만들기"}</Button>
    </form>
  </AppModal>;
}

function JoinWorkspace({ close, joined }: { close: () => void; joined: (id: string) => Promise<void> }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [joinedId, setJoinedId] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let id = joinedId;
      if (!id) {
        const result = await api<{ workspace_id: string }>("/v1/workspaces/join", {
          method: "POST", body: JSON.stringify({ code: code.trim() }),
        });
        id = result.workspace_id;
        setJoinedId(id);
      }
      await joined(id);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <AppModal title="초대 코드로 팀 참여" close={close} busy={busy}>
    <form onSubmit={submit}>
      <p className="muted">팀 소유자에게 받은 코드를 입력하세요. 초대받은 이메일로 로그인해야 합니다.</p>
      <TextInput label="초대 코드" required data-autofocus autoComplete="off" autoCapitalize="none"
        spellCheck={false} maxLength={128} value={code} disabled={busy || !!joinedId}
        onChange={(event) => setCode(event.currentTarget.value)} />
      {error && <InlineError message={error} />}
      <Button mt="sm" type="submit" loading={busy}>{joinedId ? "작업공간 다시 불러오기" : "팀에 참여하기"}</Button>
    </form>
  </AppModal>;
}

function WorkspaceMembers({ team, codeOnly, close }: { team: TeamWorkspace; codeOnly: boolean; close: () => void }) {
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

  async function prepareRoleChange(member: TeamMember, role: "member" | "guest", trigger: HTMLButtonElement) {
    if (busy) return;

    setBusy(true);
    setError("");
    const path = base + "/" + encodeURIComponent(member.id) + "/role";
    try {
      const { projects } = await api<{ projects: string[] }>(path);
      const label = role === "member" ? "팀원" : "프로젝트 게스트";
      const affected = projects.length ? "참여 프로젝트 " + projects.join(", ") : "참여 프로젝트 없음";
      setConfirmation({
        title: label + "로 변경할까요?",
        description: affected + ". 프로젝트 역할은 유지됩니다.",
        label: "역할 변경",
        trigger,
        run: async () => {
          try {
            await api(path, { method: "PATCH", body: JSON.stringify({ role }) });
            setPage(1);
            setRevision((value) => value + 1);
            return true;
          } catch (cause) {
            setError(describeError(cause));
            return false;
          }
        },
      });
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <AppModal title={team.name + " 멤버 관리"} close={close} busy={busy} suspended={!!confirmation}>
      <p className="muted">{codeOnly ? "초대 코드로만 팀에 참여할 수 있습니다. 프로젝트 권한은 별도로 초대하세요." : "가입한 계정을 팀에 추가합니다. 프로젝트 참여는 프로젝트 설정에서 따로 초대하세요."}</p>
      {!codeOnly && <form className="row wrap" onSubmit={(event) => { event.preventDefault(); void changeMember(); }}>
        <TextInput label="계정 이메일" ref={emailInput} data-autofocus type="email" required value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
        <Button type="submit" loading={busy}>팀원 추가</Button>
      </form>}
      {error && <InlineError message={error} />}
      <ul className="clean-list member-list">{members.map((member) => {
        const owner = member.organizationRoles.some(({ name }) => name === "samtdi-owner");
        const fullMember = member.organizationRoles.some(({ name }) => name === "samtdi-member");
        const linkedGuest = member.organizationRoles.some(({ name }) => name === "samtdi-guest");
        return <li key={member.id} className="row spread wrap">
          <span>{member.name || member.primaryEmail} {owner ? "· 소유자" : fullMember ? "· 팀원" : linkedGuest ? "· 프로젝트 게스트" : ""}</span>
          {!codeOnly && !owner && (fullMember || linkedGuest) && <Button size="compact-sm" variant="subtle" disabled={busy}
            onClick={(event) => void prepareRoleChange(member, fullMember ? "guest" : "member", event.currentTarget)}>
            {fullMember ? "게스트로 변경" : "팀원으로 변경"}
          </Button>}
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
      <WorkspaceInvitations workspaceId={team.id} showCode={codeOnly} />
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
      <Select label="대상 작업공간" searchable required placeholder="선택해 주세요" value={destination || null}
        data={teams.filter(({ active, owner }) => active && owner).map(({ id, name }) => ({ value: id, label: name }))}
        onChange={(value) => setDestination(value ?? "")} />
      <Button type="submit" loading={busy} disabled={!destination || destination === project.workspace_id}>작업공간에 연결</Button>
    </form>
    {error && <InlineError message={error} />}
  </section>;
}
