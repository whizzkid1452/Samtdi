"use client";

import { Badge, Button, CopyButton, TextInput } from "@mantine/core";
import { useEffect, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { InlineError, LoadingRows } from "./request-states";

type WorkspaceInvitation = components["schemas"]["WorkspaceInvitation"];

const expiryDate = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeZone: "Asia/Seoul" });

export function WorkspaceInvitations({ workspaceId, showCode }: { workspaceId: string; showCode: boolean }) {
  const base = "/v1/workspaces/" + workspaceId + "/invitations";
  const [rows, setRows] = useState<WorkspaceInvitation[]>();
  const [email, setEmail] = useState("");
  const [issued, setIssued] = useState<WorkspaceInvitation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const request = new AbortController();

    api<WorkspaceInvitation[]>(base, { signal: request.signal })
      .then((rows) => { if (!request.signal.aborted) setRows(rows); })
      .catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });

    return () => request.abort();
  }, [base, attempt]);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError("");
    try {
      const invitation = await api<WorkspaceInvitation>(base, { method: "POST", body: JSON.stringify({ email }) });
      setIssued(invitation);
      setEmail("");
      setRows((previous) => [invitation, ...(previous ?? [])]);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (busy) return;

    setBusy(true);
    setError("");
    try {
      await api(base + "/" + id, { method: "DELETE" });
      setRows((previous) => previous?.map((row) => row.id === id ? { ...row, revoked: true } : row));
      if (issued?.id === id) setIssued(undefined);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="workspace-invitations" aria-label="팀 초대">
    <h3>팀 초대</h3>
    <p className="muted">{showCode ? "초대할 이메일에 연결된 일회용 코드를 발급합니다. 가입과 개인 작업실 이용에는 코드가 필요하지 않습니다." : "이메일로 초대 링크를 만들 수 있습니다. 팀에 참여한 뒤 프로젝트별 권한을 받을 수 있습니다."}</p>
    <form className="row wrap" onSubmit={invite}>
      <TextInput label="초대할 이메일" type="email" required value={email} disabled={busy}
        onChange={(event) => setEmail(event.currentTarget.value)} />
      <Button type="submit" loading={busy}>{showCode ? "팀 초대 코드 만들기" : "팀 초대 링크 만들기"}</Button>
    </form>
    {showCode && issued?.code && <div className="row wrap">
      <TextInput label="팀 초대 코드" value={issued.code} readOnly />
      <CopyButton value={issued.code}>
        {({ copied, copy }) => <Button variant="default" onClick={copy}>{copied ? "복사됨" : "코드 복사"}</Button>}
      </CopyButton>
    </div>}
    {issued?.accept_url && <div className="row wrap">
      <TextInput label="팀 초대 링크" value={issued.accept_url} readOnly />
      <CopyButton value={issued.accept_url}>
        {({ copied, copy }) => <Button variant="default" onClick={copy}>{copied ? "복사됨" : "링크 복사"}</Button>}
      </CopyButton>
    </div>}
    {error && <InlineError message={error} retry={() => { setError(""); setAttempt((value) => value + 1); }} />}
    {!rows && !error && <LoadingRows label="팀 초대를 불러오는 중" />}
    {rows && rows.length === 0 && <p className="muted">발급한 팀 초대가 없습니다.</p>}
    <ul className="clean-list">
      {rows?.map((row) => {
        const actionable = !row.revoked && !row.accepted && !row.expired;
        const status = row.accepted ? "수락됨" : row.revoked ? "취소됨" : row.expired ? "만료됨" : "응답 대기";

        return <li className="row spread wrap" key={row.id}>
          <span>{row.email}</span>
          <span className="muted"><Badge variant="light" tt="none">{status}</Badge> {expiryDate.format(new Date(row.expires_at))}</span>
          {actionable && <Button variant="subtle" disabled={busy} onClick={() => void revoke(row.id)}>초대 취소</Button>}
        </li>;
      })}
    </ul>
  </section>;
}
