export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, cache: "no-store" });

  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new ApiError(response.status, result?.error ?? "request_failed");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function describeError(error: unknown) {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      identity_service_unavailable: "로그인 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      identity_link_required: "기존 계정을 새 로그인에 연결해야 합니다. 운영자에게 계정 연결을 요청해 주세요.",
      workspace_provisioning_pending: "작업공간 생성 결과를 확인하는 중입니다. 잠시 후 같은 작업공간으로 이어가 주세요. 계속되면 운영자에게 확인을 요청해 주세요.",
      workspace_request_conflict: "이 요청으로 준비 중인 작업공간 이름과 다릅니다. 기존 작업공간에서 이어가 주세요.",
      project_member_identity_link_required: "기존 프로젝트 멤버의 로그인 계정을 먼저 연결해 주세요.",
      project_member_workspace_required: "프로젝트 멤버 모두를 대상 작업공간에 먼저 추가해 주세요.",
      registered_user_not_found: "가입한 계정을 찾을 수 없습니다. 이메일을 확인해 주세요.",
      workspace_required: "프로젝트를 만들 작업공간을 선택해 주세요.",
    };
    if (messages[error.code]) return messages[error.code];
    if (error.code === "project_archived") return "보관된 프로젝트입니다.";
    if (error.status === 409) return "최신 상태를 확인한 뒤 다시 시도해 주세요.";
    if (error.status === 401) return "로그인이 만료되었습니다.";
    if (error.status === 403 || error.status === 404) return "이 항목을 열거나 변경할 권한이 없습니다.";
  }
  return "요청을 처리하지 못했습니다. 입력과 연결을 확인해 주세요.";
}
