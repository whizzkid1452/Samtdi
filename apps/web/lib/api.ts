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
    if (error.code === "project_archived") return "보관된 프로젝트입니다.";
    if (error.status === 409) return "최신 상태를 확인한 뒤 다시 시도해 주세요.";
    if (error.status === 401) return "로그인이 만료되었습니다.";
    if (error.status === 403 || error.status === 404) return "이 항목을 열거나 변경할 권한이 없습니다.";
  }
  return "요청을 처리하지 못했습니다. 입력과 연결을 확인해 주세요.";
}
