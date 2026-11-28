"use client";

import { BrandWordmark } from "../../brand-wordmark";
import { Button } from "@mantine/core";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError, describeError } from "../../../lib/api";
import type { components } from "../../../lib/api-types";
import { clearIdentitySession } from "../../../lib/supabase-identity";
import { InlineError, LoadingRows } from "../../request-states";

type Invitation = components["schemas"]["InvitationPreview"];
type Session = components["schemas"]["Session"];
type AcceptedInvitation = components["schemas"]["AcceptedInvitation"];

const roleLabels: Record<Invitation["role"], string> = {
  reviewer: "검토자", editor: "편집자", owner: "소유자", member: "팀원",
};

async function loadSession(signal: AbortSignal) {
  try {
    return await api<Session>("/v1/me", { signal });
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) return null;
    throw cause;
  }
}

export function InvitationScreen({ token }: { token: string }) {
  const invitationPath = "/v1/auth/invitations/" + encodeURIComponent(token);
  const [invitation, setInvitation] = useState<Invitation>();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [action, setAction] = useState<"accept" | "switch-account" | null>(null);
  const [actionError, setActionError] = useState("");
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    const request = new AbortController();

    async function loadInvitation() {
      let preview: Invitation;
      try {
        preview = await api<Invitation>(invitationPath, { signal: request.signal });
      } catch (cause) {
        if (request.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 404) setExpired(true);
        else setError(describeError(cause));
        return;
      }

      try {
        const account = await loadSession(request.signal);
        if (request.signal.aborted) return;
        setSession(account);
        setInvitation(preview);
      } catch (cause) {
        if (!request.signal.aborted) setError(describeError(cause));
      }
    }

    void loadInvitation();
    return () => request.abort();
  }, [invitationPath, attempt]);

  const loginHref = "/v1/auth/login?" + new URLSearchParams({ invite: token, return_to: invitation?.return_to ?? "/projects" });

  async function acceptInvitation() {
    setAction("accept");
    setActionError("");
    setRejected(false);
    try {
      // The invite page suppresses referrers. The API needs the origin for cookie-authenticated writes.
      const accepted = await api<AcceptedInvitation>(invitationPath, { method: "POST", referrerPolicy: "origin" });
      window.location.replace(accepted.return_to);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) setSession(null);
      if (cause instanceof ApiError && cause.code === "invitation_rejected") {
        setRejected(true);
        setActionError("이 계정으로 초대를 수락할 수 없어요. 초대받은 이메일과 참여 권한을 확인해 주세요.");
      } else {
        setActionError(describeError(cause));
      }
      setAction(null);
    }
  }

  async function switchAccount() {
    setAction("switch-account");
    setActionError("");
    try {
      await api("/v1/auth/logout", { method: "POST", referrerPolicy: "origin" }).catch((cause) => {
        if (!(cause instanceof ApiError && cause.status === 401)) throw cause;
      });
      await clearIdentitySession().catch(() => undefined);
      window.location.replace(loginHref);
    } catch (cause) {
      setActionError(describeError(cause));
      setAction(null);
    }
  }

  return <main className="login invite-entry">
    <div className="login-content">
      <Link href="/projects" className="brand" aria-label="사맛디 홈"><BrandWordmark /></Link>
      {invitation && <>
        <h1>{invitation.title}에 초대받았어요</h1>
        <p className="muted">{roleLabels[invitation.role]}로 참여합니다. {session ? `${session.email} 계정으로 참여해요.` : "초대받은 이메일로 로그인하세요."}</p>
        {invitation.kind === "project" && <p className="muted">다른 팀 프로젝트와 팀 설정에는 별도 권한이 필요합니다.</p>}
        {actionError && <p role="alert">{actionError}</p>}
        {session ? <div className="row wrap">
          <Button loading={action === "accept"} disabled={action === "switch-account"} onClick={() => void acceptInvitation()}>
            초대 수락
          </Button>
          {rejected && <Button variant="subtle" loading={action === "switch-account"} onClick={() => void switchAccount()}>
            다른 계정으로 로그인
          </Button>}
        </div> : <Button component="a" href={loginHref}>로그인</Button>}
      </>}
      {expired && <>
        <h1>초대를 열 수 없어요</h1>
        <p className="muted">만료되거나 취소된 초대입니다. 프로젝트 또는 팀 소유자에게 새 링크를 요청하세요.</p>
        <Button component={Link} href="/projects">프로젝트 목록으로</Button>
      </>}
      {error && <InlineError message={error} retry={() => { setError(""); setAttempt((value) => value + 1); }} />}
      {!invitation && !expired && !error && <LoadingRows label="초대를 확인하는 중" />}
    </div>
  </main>;
}
