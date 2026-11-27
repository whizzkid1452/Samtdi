"use client";

import { BrandWordmark } from "../../brand-wordmark";
import { Button } from "@mantine/core";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError, describeError } from "../../../lib/api";
import type { components } from "../../../lib/api-types";
import { InlineError, LoadingRows } from "../../request-states";

type Invitation = components["schemas"]["InvitationPreview"];

const roleLabels: Record<Invitation["role"], string> = {
  reviewer: "검토자", editor: "편집자", owner: "소유자", member: "팀원",
};

export function InvitationScreen({ token }: { token: string }) {
  const [invitation, setInvitation] = useState<Invitation>();
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const request = new AbortController();

    api<Invitation>("/v1/auth/invitations/" + encodeURIComponent(token), { signal: request.signal })
      .then((result) => { if (!request.signal.aborted) setInvitation(result); })
      .catch((cause) => {
        if (request.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 404) setExpired(true);
        else setError(describeError(cause));
      });

    return () => request.abort();
  }, [token, attempt]);

  return <main className="login invite-entry">
    <div className="login-content">
      <Link href="/projects" className="brand"><BrandWordmark /></Link>
      {invitation && <>
        <h1>{invitation.title}에 초대받았어요</h1>
        <p className="muted">{roleLabels[invitation.role]}로 참여합니다. 초대받은 이메일로 로그인하세요.</p>
        {invitation.kind === "project" && <p className="muted">다른 팀 프로젝트와 팀 설정에는 별도 권한이 필요합니다.</p>}
        <Button component="a" href={"/v1/auth/login?" + new URLSearchParams({ invite: token, return_to: invitation.return_to })}>
          로그인
        </Button>
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
