"use client";

import { Alert, Button, PasswordInput, Stack, TextInput } from "@mantine/core";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { identityClient } from "../../../lib/supabase-identity";

type Consent = { id: string; email: string };
type Phase = "loading" | "login" | "check-email" | "restart-login" | "consent" | "unavailable";
const loginPath = "/v1/auth/login?return_to=%2Fprojects";
const returnPath = "/v1/auth/callback";

function safeRedirect(raw: string) {
  const target = new URL(raw);
  if (target.origin !== window.location.origin || target.pathname !== returnPath || target.hash) {
    throw new Error("잘못된 로그인 반환 주소입니다.");
  }
  window.location.assign(target.href);
}

export default function ConsentPage() {
  const params = useSearchParams();
  const authorizationId = params.get("authorization_id");
  const [phase, setPhase] = useState<Phase>("loading");
  const [consent, setConsent] = useState<Consent | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signup, setSignup] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    async function load() {
      const client = identityClient();
      const allowedClient = process.env.NEXT_PUBLIC_SAMTDI_OAUTH_CLIENT_ID;
      if (!client || !allowedClient) {
        if (alive) { setPhase("unavailable"); setMessage("로그인 설정을 준비 중입니다."); }
        return;
      }
      try {
        const { data, error } = await client.auth.getSession();
        if (!alive) return;
        if (!authorizationId) {
          setMessage(data.session ? "" : "이메일 인증을 마쳤다면 가입한 이메일과 비밀번호로 로그인해 주세요.");
          setPhase("restart-login");
          return;
        }
        if (error) throw error;
        if (!data.session) {
          if (sessionStorage.getItem("samtdi:signup-intent") === "1") {
            sessionStorage.removeItem("samtdi:signup-intent");
            setSignup(true);
          }
          setPhase("login");
          return;
        }
        const result = await client.auth.oauth.getAuthorizationDetails(authorizationId);
        if (result.error) throw result.error;
        if (!alive) return;
        if ("redirect_url" in result.data) { safeRedirect(result.data.redirect_url); return; }
        const details = result.data;
        const callback = new URL(details.redirect_uri);
        const scopes = details.scope.split(/\s+/);
        if (details.client.id !== allowedClient || callback.origin !== window.location.origin ||
            callback.pathname !== returnPath || callback.search || callback.hash ||
            scopes.some(scope => !["openid", "email", "profile"].includes(scope))) {
          throw new Error("허용되지 않은 로그인 요청입니다.");
        }
        setConsent({ id: details.authorization_id, email: details.user.email });
        setPhase("consent");
      } catch {
        if (alive) { setPhase("unavailable"); setMessage("로그인 요청을 확인할 수 없습니다. 다시 시작해 주세요."); }
      }
    }
    void load();
    return () => { alive = false; };
  }, [authorizationId, refresh]);

  async function authenticate(event: FormEvent) {
    event.preventDefault();
    const client = identityClient();
    if (!client || pending) return;
    setPending(true);
    setMessage("");
    try {
      if (signup) {
        const { data, error } = await client.auth.signUp({
          email, password, options: { emailRedirectTo: window.location.origin + "/oauth/consent" },
        });
        if (error) throw error;
        if (!data.session) {
          setPassword("");
          setPhase("check-email");
          return;
        }
      } else {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      setPassword("");
      setRefresh(value => value + 1);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "";
      if (signup && (code === "email_address_not_authorized" || code === "over_email_send_rate_limit")) {
        setMessage("가입 확인 이메일을 지금 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.");
      } else if (signup && code === "weak_password") {
        setMessage("비밀번호가 보안 조건을 충족하지 않습니다. 더 길고 복잡한 비밀번호로 다시 시도해 주세요.");
      } else if (!signup && code === "email_not_confirmed") {
        setMessage("받은 확인 이메일의 링크를 열어 주소를 인증한 후 다시 로그인해 주세요.");
      } else setMessage(signup ? "가입을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요." :
        "로그인에 실패했습니다. 인증된 이메일과 비밀번호를 확인해 주세요.");
    } finally { setPending(false); }
  }

  async function decide(approved: boolean) {
    const client = identityClient();
    if (!client || !consent || pending) return;
    setPending(true);
    setMessage("");
    try {
      const result = approved
        ? await client.auth.oauth.approveAuthorization(consent.id, { skipBrowserRedirect: true })
        : await client.auth.oauth.denyAuthorization(consent.id, { skipBrowserRedirect: true });
      if (result.error) throw result.error;
      safeRedirect(result.data.redirect_url);
    } catch { setMessage("인증을 완료하지 못했습니다. 다시 로그인해 주세요."); }
    finally { setPending(false); }
  }

  return <main className="login">
    <div className="login-content" style={{ maxWidth: 420 }}>
      <p><Link href="/projects" className="brand" aria-label="사맛디 홈">사맛디</Link></p>
      <h1>{phase === "check-email" ? "이메일을 확인해 주세요" :
        phase === "consent" ? "사맛디 로그인 확인" : "음악을 함께 완성하는 공간"}</h1>
      {message && <Alert role="status" color="gray" mb="md">{message}</Alert>}
      {phase === "loading" && <p role="status">인증 요청을 확인하는 중…</p>}
      {phase === "check-email" && <Stack>
        <p>받은 확인 이메일의 링크로 주소를 인증해 주세요. 이미 인증했다면 로그인할 수 있어요.</p>
        <Button onClick={() => {
          setSignup(false);
          setPhase("login");
        }}>로그인하기</Button>
      </Stack>}
      {phase === "restart-login" && <Button component="a" href={loginPath}>로그인 계속하기</Button>}
      {phase === "login" && <form onSubmit={authenticate}>
        <Stack>
          <TextInput label="이메일" type="email" autoComplete="email" value={email} required onChange={e => setEmail(e.currentTarget.value)} />
          <PasswordInput label="비밀번호" autoComplete={signup ? "new-password" : "current-password"} minLength={signup ? 8 : undefined} required value={password} onChange={e => setPassword(e.currentTarget.value)} />
          <Button fullWidth type="submit" loading={pending}>{signup ? "이메일로 가입" : "로그인"}</Button>
          <Button variant="subtle" type="button" disabled={pending} onClick={() => { setSignup(!signup); setMessage(""); }}>
            {signup ? "이미 계정이 있어요" : "계정 만들기"}
          </Button>
        </Stack>
      </form>}
      {phase === "consent" && consent && <Stack>
        <p className="muted">{consent.email} 계정의 확인된 이메일과 사용자 식별자를 사맛디에 제공해 로그인합니다.</p>
        <Button loading={pending} onClick={() => void decide(true)}>계속하기</Button>
        <Button variant="subtle" disabled={pending} onClick={() => void decide(false)}>취소</Button>
      </Stack>}
      {phase === "unavailable" && <Button component="a" href="/">작업실 돌아가기</Button>}
    </div>
  </main>;
}
