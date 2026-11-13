"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import type { Member, Project } from "./workspace";

const roles = { reviewer: "검토자", editor: "편집자", owner: "소유자" };

export function ProjectMembers({ project }: { project: Project }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invite, setInvite] = useState<{ id: string; accept_url: string }>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/v1/projects/${project.id}`;
  const canManage = project.role === "owner" && !project.archived_at;

  useEffect(() => {
    const request = new AbortController();
    api<Member[]>(base + "/members", { signal: request.signal }).then(setMembers).catch((cause) => {
      if (!request.signal.aborted) setError(describeError(cause));
    });
    return () => request.abort();
  }, [base]);

  async function change(action: () => Promise<void>) {
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await change(async () => {
      setInvite(await api(base + "/invitations", {
        method: "POST", body: JSON.stringify({ email: data.get("email"), role: data.get("role") }),
      }));
      form.reset();
    });
  }

  async function editMember(accountId: string, role?: Project["role"]) {
    await change(async () => {
      await api(base + "/members/" + accountId, role
        ? { method: "PATCH", body: JSON.stringify({ role }) }
        : { method: "DELETE" });
      setMembers(await api(base + "/members"));
    });
  }

  return (
    <details className="panel" open>
      <summary>팀원</summary>
      {error && <p className="error" role="alert">{error}</p>}
      <ul className="clean-list">
        {members.map((member) => <li className="row spread" key={member.account_id}>
          <span>{member.email}</span>
          {canManage ? <div className="row">
            <select aria-label={member.email + " 역할"} value={member.role} onChange={(event) => void editMember(member.account_id, event.target.value as Project["role"])}>
              {Object.entries(roles).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
            </select>
            <button aria-label={member.email + " 제거"} onClick={() => void editMember(member.account_id)}>제거</button>
          </div> : <span className="muted">{roles[member.role]}</span>}
        </li>)}
      </ul>
      {canManage && <form className="row wrap" onSubmit={inviteMember}>
        <input type="email" name="email" placeholder="초대할 이메일" aria-label="초대할 이메일" required />
        <select name="role" aria-label="초대 역할"><option value="reviewer">검토자</option><option value="editor">편집자</option><option value="owner">소유자</option></select>
        <button>초대 링크 만들기</button>
      </form>}
      {invite && canManage && <div className="row wrap">
        <input aria-label="초대 링크" readOnly value={invite.accept_url} />
        <button onClick={() => void change(async () => {
          await navigator.clipboard.writeText(invite.accept_url);
          setNotice("초대 링크를 복사했습니다.");
        })}>복사</button>
        <button onClick={() => void change(async () => {
          await api(base + "/invitations/" + invite.id, { method: "DELETE" });
          setInvite(undefined);
        })}>초대 취소</button>
      </div>}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
