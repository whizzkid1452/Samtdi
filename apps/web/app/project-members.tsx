"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import { projectHref } from "../lib/routes";
import { Dialog } from "./dialog";
import { useWorkspace, type Member, type Project } from "./workspace";

const roles = { reviewer: "검토자", editor: "편집자", owner: "소유자" };
const formatExpiry = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul" });

export function ProjectMembers({ project }: { project: Project }) {
  const { refreshProjects } = useWorkspace();
  const [members, setMembers] = useState<Member[]>();
  const [invite, setInvite] = useState<{ id: string; accept_url: string; expires_at: string }>();
  const [inviting, setInviting] = useState(false);
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
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await change(async () => {
      const created = await api<{ id: string; accept_url: string; expires_at: string }>(base + "/invitations", {
        method: "POST", body: JSON.stringify({ email: data.get("email"), role: data.get("role") }),
      });
      const href = new URL(created.accept_url);
      href.searchParams.set("return_to", projectHref(project.id));

      setInvite({ ...created, accept_url: href.href });
      setInviting(false);
      setNotice("초대 링크를 만들었습니다.");
    });
  }

  async function editMember(member: Member, role?: Project["role"]) {
    if (!role && !window.confirm(member.email + "의 프로젝트 접근 권한을 제거할까요?")) return;
    await change(async () => {
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
      <h2>팀원</h2>
      {canManage && <button className="primary" onClick={() => { setError(""); setInviting(true); }}>팀원 초대</button>}
    </div>
    {error && !inviting && <div className="row wrap" role="alert"><span className="error">{error}</span>
      <button onClick={() => { setError(""); setAttempt((value) => value + 1); }}>팀원 다시 불러오기</button></div>}
    {!members && !error && <p role="status">팀원을 불러오는 중</p>}
    <ul className="clean-list member-list">
      {members?.map((member) => <li className="row spread wrap" key={member.account_id}>
        <span>{member.email}</span>
        {canManage ? <div className="row wrap">
          <select aria-label={member.email + " 역할"} value={member.role} disabled={busy}
            onChange={(event) => void editMember(member, event.target.value as Project["role"])}>
            {Object.entries(roles).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
          </select>
          <button disabled={busy} aria-label={member.email + " 제거"} onClick={() => void editMember(member)}>제거</button>
        </div> : <span className="status-label">{roles[member.role]}</span>}
      </li>)}
    </ul>
    {invite && canManage && <div className="notice">
      <div className="row wrap">
        <input aria-label="초대 링크" readOnly value={invite.accept_url} />
        <button disabled={busy} onClick={() => void change(async () => {
          await navigator.clipboard.writeText(invite.accept_url);
          setNotice("초대 링크를 복사했습니다.");
        })}>복사</button>
        <button disabled={busy} onClick={() => {
          if (!window.confirm("이 초대를 취소할까요?")) return;
          void change(async () => {
            await api(base + "/invitations/" + invite.id, { method: "DELETE" });
            setInvite(undefined);
            setNotice("초대를 취소했습니다.");
          });
        }}>초대 취소</button>
      </div>
      <p className="muted">{formatExpiry.format(new Date(invite.expires_at))}까지 사용할 수 있습니다.</p>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {inviting && canManage && <Dialog title="팀원 초대" close={() => { if (!busy) setInviting(false); }}>
      <form className="task-editor" onSubmit={inviteMember}>
        <label>초대할 이메일<input type="email" name="email" required /></label>
        <label>역할<select name="role" aria-label="초대 역할">
          <option value="reviewer">검토자</option><option value="editor">편집자</option><option value="owner">소유자</option>
        </select></label>
        {error && <p role="alert" className="error">{error}</p>}
        <button className="primary" disabled={busy}>초대 링크 만들기</button>
      </form>
    </Dialog>}
  </section>;
}
