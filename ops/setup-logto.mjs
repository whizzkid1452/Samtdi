import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const endpoint = process.env.SAMTDI_LOGTO_ENDPOINT ?? "http://127.0.0.1:3001";
const origin = process.env.AYOTBI_ORIGIN ?? "http://127.0.0.1:3100";
const bootstrap = process.env.LOGTO_BOOTSTRAP_TOKEN;
if (!bootstrap) throw new Error("LOGTO_BOOTSTRAP_TOKEN에 관리 API 토큰을 설정하세요.");
if (process.argv.includes("--demo") && (new URL(endpoint).hostname !== "127.0.0.1" || new URL(origin).hostname !== "127.0.0.1")) {
  throw new Error("데모 계정은 루프백 개발 환경에서만 만들 수 있습니다.");
}

async function api(path, { method = "GET", data } = {}) {
  const response = await fetch(endpoint + "/api" + path, {
    method, headers: { Authorization: "Bearer " + bootstrap, "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Logto 설정 실패: ${method} ${path.split("?")[0]} HTTP ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

async function findOrCreate({ path, name, data }) {
  const rows = [];
  for (let page = 1; ; page++) {
    const batch = await api(path + "?page_size=100&page=" + page);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  const matches = rows.filter((row) => row.name === name);
  if (matches.length > 1) throw new Error("중복된 Logto 설정을 먼저 정리하세요: " + name);
  return matches[0] ?? api(path, { method: "POST", data: { name, ...data } });
}

const web = await findOrCreate({ path: "/applications", name: "Samtdi Web", data: {
  type: "Traditional", oidcClientMetadata: { redirectUris: [origin + "/v1/auth/callback"], postLogoutRedirectUris: [origin + "/projects"] },
} });
if (web.type !== "Traditional") throw new Error("Samtdi Web은 Traditional 애플리케이션이어야 합니다.");
await api("/applications/" + web.id, { method: "PATCH", data: {
  oidcClientMetadata: { ...web.oidcClientMetadata,
    redirectUris: [...new Set([...(web.oidcClientMetadata.redirectUris ?? []), origin + "/v1/auth/callback"])],
    postLogoutRedirectUris: [...new Set([...(web.oidcClientMetadata.postLogoutRedirectUris ?? []), origin + "/projects"])],
  },
} });
const machine = await findOrCreate({ path: "/applications", name: "Samtdi Server", data: { type: "MachineToMachine" } });
if (machine.type !== "MachineToMachine") throw new Error("Samtdi Server는 MachineToMachine 애플리케이션이어야 합니다.");
const resources = await api("/resources?page_size=100");
const resource = resources.find((row) => row.indicator === (process.env.SAMTDI_LOGTO_RESOURCE ?? "https://default.logto.app/api"));
if (!resource) throw new Error("Logto Management API 리소스를 찾을 수 없습니다.");
const scopes = await api("/resources/" + resource.id + "/scopes");
const scope = scopes.find((row) => row.name === "all");
if (!scope) throw new Error("Management API의 all scope를 찾을 수 없습니다.");
const role = await findOrCreate({ path: "/roles", name: "Samtdi management", data: { type: "MachineToMachine", description: "Samtdi server Management API access" } });
if (!(await api("/roles/" + role.id + "/scopes")).some((entry) => entry.id === scope.id)) {
  await api("/roles/" + role.id + "/scopes", { method: "POST", data: { scopeIds: [scope.id] } });
}
if (!(await api("/applications/" + machine.id + "/roles")).some((entry) => entry.id === role.id)) {
  await api("/applications/" + machine.id + "/roles", { method: "POST", data: { roleIds: [role.id] } });
}
for (const name of ["samtdi-owner", "samtdi-member", "samtdi-guest"]) {
  await findOrCreate({ path: "/organization-roles", name, data: { description: "Samtdi workspace role" } });
}

if (process.argv.includes("--demo")) {
  if (new URL(endpoint).hostname !== "127.0.0.1" || new URL(origin).hostname !== "127.0.0.1") {
    throw new Error("데모 계정은 루프백 개발 환경에서만 만들 수 있습니다.");
  }
  for (const username of ["owner", "reviewer"]) {
    const users = await api("/users?" + new URLSearchParams({ "search.username": username, page_size: "100" }));
    if (!users.some((row) => row.username === username)) {
      await api("/users", { method: "POST", data: {
        username, primaryEmail: username + "@example.test", name: username === "owner" ? "프로듀서" : "검토자", password: "Samtdi-demo-2026!",
      } });
    }
  }
  await api("/sign-in-exp", { method: "PATCH", data: {
    signUp: { identifiers: ["username"], password: true, verify: false },
    signIn: { methods: [{ identifier: "username", password: true, verificationCode: false, isPasswordPrimary: true }] },
  } });
}

async function applicationSecret(id) {
  const path = "/applications/" + id + "/secrets";
  const secrets = await api(path);
  const secret = secrets.find((entry) => entry.name === "samtdi-service") ?? await api(path, { method: "POST", data: { name: "samtdi-service" } });
  if (secret.expiresAt && secret.expiresAt <= Date.now()) throw new Error("samtdi-service secret의 갱신이 필요합니다.");
  return secret.value;
}

const settings = {
  AYOTBI_OIDC_ISSUER: endpoint + "/oidc", AYOTBI_OIDC_CLIENT_ID: web.id, AYOTBI_OIDC_CLIENT_SECRET: await applicationSecret(web.id),
  SAMTDI_LOGTO_ENDPOINT: endpoint, SAMTDI_LOGTO_M2M_CLIENT_ID: machine.id, SAMTDI_LOGTO_M2M_CLIENT_SECRET: await applicationSecret(machine.id),
  SAMTDI_LOGTO_RESOURCE: resource.indicator,
};
if (Object.values(settings).some((value) => typeof value !== "string" || !value || /[\r\n']/.test(value))) {
  throw new Error("애플리케이션 자격을 확인할 수 없습니다. Logto Console에서 secret을 확인하세요.");
}
const destination = resolve(process.env.SAMTDI_LOGTO_ENV_FILE ?? ".local/logto.env");
await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
await writeFile(destination, Object.entries(settings).map(([key, value]) => `${key}='${value}'`).join("\n") + "\n", { mode: 0o600 });
await chmod(destination,0o600);
console.log("Logto OIDC·조직 역할 설정 완료. 자격은 " + destination + "에 저장했습니다.");
