"use client";

import { Badge, Button, NativeSelect, TextInput } from "@mantine/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import { displayName } from "../lib/people";
import { projectHref } from "../lib/routes";
import { AppModal } from "./app-modal";
import { ConfirmAction, type Confirmation } from "./confirm-action";
import { useWorkspace, type Member, type Project } from "./workspace";
import { EmptyState, InlineError, LoadingRows } from "./request-states";

const roles = { reviewer: "검토자", editor: "편집자", owner: "소유자" };
const formatExpiry = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul" });

export function ProjectRoleBadge({ role }: { role: Project["role"] }) {
  return <Badge variant="light" color={role === "owner" ? "samtdi" : role === "editor" ? "blue" : "gray"} tt="none">{roles[role]}</Badge>;
}

export function ProjectMembers({ project }: { project: Project }) {
  const { refreshProjects } = useWorkspace();
  const [members, setMembers] = useState<Member[]>();
  const [invite, setInvite] = useState<{ id: string; accept_url: string; expires_at: string }>();
  const [inviting, setInviting] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const base = "/v1/projects/" + project.id;
  const canManage = project.role === "owner" && !project.archived_at;

  useEffect(() => {
    const request = new AbortController();

    api<Member[]>(base + "/members", { signal: request.signal }).then((rows) => {
      if (!request.signal.aborted) setMembers(rows);
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });
    return () => request.abort();
  }, [base, attempt]);

  async function change(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      return true;
    } catch (cause) {
      setError(describeError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await change(async () => {
      const created = await api<{ id: string; accept_url: string; expires_at: string; preview_url?: string }>(base + "/invitations", {
        method: "POST", body: JSON.stringify({ email: data.get("email"), role: data.get("role") }),
      });
      const href = new URL(created.accept_url);
      href.searchParams.set("return_to", projectHref(project.id));

      setInvite({ ...created, accept_url: created.preview_url ?? href.href });
      setInviting(false);
      setNotice("초대 링크를 만들었습니다.");
    });
  }

  async function editMember(member: Member, role?: Project["role"]) {
    return change(async () => {
      await api(base + "/members/" + member.account_id, role
        ? { method: "PATCH", body: JSON.stringify({ role }) }
        : { method: "DELETE" });
      setNotice(role ? "팀원 권한을 변경했습니다." : "팀원을 제거했습니다.");
      setAttempt((value) => value + 1);
      await refreshProjects();
    });
  }

  return <section className="panel" aria-label="팀원">
    <div className="row spread wrap">
      <h2 ref={heading} tabIndex={-1}>팀원</h2>
      {canManage && <Button onClick={() => { setError(""); setInviting(true); }}>팀원 초대</Button>}
    </div>
    {error && !inviting && <InlineError message={error} retryLabel="팀원 다시 불러오기"
      retry={() => { setError(""); setAttempt((value) => value + 1); }} />}
    {!members && !error && <LoadingRows label="팀원을 불러오는 중" />}
    {members?.length === 0 && <EmptyState message="표시할 팀원이 없습니다." />}
    <ul className="clean-list member-list">
      {members?.map((member) => <li className="row spread wrap" key={member.account_id}>
        <span>{displayName(member)}{member.name && <span className="muted"> · {member.email}</span>}</span>
        {canManage ? <div className="row wrap">
          <NativeSelect aria-label={member.email + " 역할"} value={member.role} disabled={busy}
            data={Object.entries(roles).map(([value, label]) => ({ value, label }))}
            onChange={(event) => void editMember(member, event.currentTarget.value as Project["role"])} />
          <button disabled={busy} aria-label={member.email + " 제거"} onClick={(event) => setConfirmation({
            title: "팀원 제거",
            description: member.email + "의 프로젝트 접근 권한을 제거할까요?",
            label: "제거",
            trigger: event.currentTarget,
            focusAfterSuccess: heading.current,
            run: () => editMember(member),
          })}>제거</button>
        </div> : <ProjectRoleBadge role={member.role} />}
      </li>)}
    </ul>
    {invite && canManage && <div className="notice">
      <div className="row wrap">
        <TextInput aria-label="초대 링크" readOnly value={invite.accept_url} />
        <button disabled={busy} onClick={() => void change(async () => {
          await navigator.clipboard.writeText(invite.accept_url);
          setNotice("초대 링크를 복사했습니다.");
        })}>복사</button>
        <button disabled={busy} onClick={(event) => setConfirmation({
          title: "초대 취소",
          description: "발급한 초대 링크를 사용할 수 없게 할까요?",
          label: "초대 취소",
          trigger: event.currentTarget,
          focusAfterSuccess: heading.current,
          run: () => change(async () => {
            await api(base + "/invitations/" + invite.id, { method: "DELETE" });
            setInvite(undefined);
            setNotice("초대를 취소했습니다.");
          }),
        })}>초대 취소</button>
      </div>
      <p className="muted">{formatExpiry.format(new Date(invite.expires_at))}까지 사용할 수 있습니다.</p>
    </div>}
    {confirmation && <ConfirmAction confirmation={confirmation} actionError={error} close={() => setConfirmation(undefined)} />}
    {notice && <p role="status">{notice}</p>}
    {inviting && canManage && <AppModal title="팀원 초대" close={() => setInviting(false)} busy={busy}>
      <form className="task-editor" onSubmit={inviteMember}>
        <TextInput label="초대할 이메일" type="email" name="email" required data-autofocus />
        <NativeSelect label="역할" name="role" aria-label="초대 역할" defaultValue="reviewer"
          data={Object.entries(roles).map(([value, label]) => ({ value, label }))} />
        {error && <InlineError message={error} />}
        <Button type="submit" loading={busy}>초대 링크 만들기</Button>
      </form>
    </AppModal>}
  </section>;
}
