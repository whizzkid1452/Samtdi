"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { itemHref, projectHref, versionHref } from "../lib/routes";
import { useUpload } from "./upload";
import { VersionReview, feedbackDraftKey, readDraft } from "./version-review";
import type { Project } from "./workspace";

type MediaItem = components["schemas"]["MediaItem"];
export type MediaVersion = components["schemas"]["MediaVersion"];

const states: Record<MediaVersion["state"], string> = { queued: "처리 대기", processing: "처리 중", ready: "재생 가능", failed: "처리 실패" };
const uploadedAt = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });
const pageSize = 100;

function VersionStatus({ version }: { version: MediaVersion }) {
  return <span className={"status-label status-" + version.state}>{states[version.state]}</span>;
}

export function MediaLibrary({ project }: { project: Project }) {
  const { openUpload } = useUpload();
  const router = useRouter();
  const pathname = usePathname();
  const query = useSearchParams();
  const [search, setSearch] = useState(query.get("q") ?? "");
  const archived = query.get("archived") === "true";
  const canEdit = project.role !== "reviewer" && !project.archived_at;

  function filter(value: string, showArchived: boolean) {
    const params = new URLSearchParams();
    if (value.trim()) params.set("q", value.trim());
    if (showArchived) params.set("archived", "true");
    router.push(pathname + (params.size ? "?" + params : ""));
  }

  return <section aria-label="음원 목록" onDragOver={canEdit ? (event) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  } : undefined} onDrop={canEdit ? (event) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    openUpload({ projectId: project.id, file: event.dataTransfer.files[0] });
  } : undefined}>
    <div className="row wrap spread section-header">
      <h2 className="section-title">음원</h2>
      {canEdit && <button className="primary" onClick={() => openUpload({ projectId: project.id })}>음원 업로드</button>}
    </div>
    <form className="row wrap filter-bar" onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      filter(search, archived);
    }}>
      <input type="search" aria-label="음원 검색" placeholder="음원 검색" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} />
      <button>검색</button>
      <label className="row"><input type="checkbox" checked={archived} onChange={(event) => filter(query.get("q") ?? "", event.target.checked)} /> 보관된 음원</label>
    </form>
    <MediaRows key={query.toString()} projectId={project.id} search={query.get("q") ?? ""} archived={archived} />
  </section>;
}

function MediaRows({ projectId, search, archived }: { projectId: string; search: string; archived: boolean }) {
  const { uploadRevision } = useUpload();
  const [items, setItems] = useState<MediaItem[]>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const path = "/v1/projects/" + projectId + "/media?" + new URLSearchParams({ archived: String(archived), q: search });

  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const rows = await api<MediaItem[]>(path, { signal: request.signal });
        if (request.signal.aborted) return;

        setItems((previous) => [...rows, ...(previous?.slice(pageSize) ?? []).filter((item) => !rows.some(({ id }) => id === item.id))]);
        setMore(rows.length === pageSize);
        setError("");
        if (rows.some(({ latest }) => latest?.state === "queued" || latest?.state === "processing")) {
          timer = setTimeout(() => void load(), 2000);
        }
      } catch (cause) {
        if (!request.signal.aborted) setError(describeError(cause));
      }
    }

    void load();
    return () => { request.abort(); clearTimeout(timer); };
  }, [path, refresh, uploadRevision]);

  async function loadMore() {
    const before = items?.at(-1)?.id;
    if (!before || loadingMore) return;

    setLoadingMore(true);
    try {
      const rows = await api<MediaItem[]>(path + "&before=" + before);
      setItems((previous) => [...(previous ?? []), ...rows.filter((row) => !previous?.some(({ id }) => id === row.id))]);
      setMore(rows.length === pageSize);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  return <>
    {error && <div className="row wrap" role="alert"><span className="error">{error}</span>
      <button onClick={() => setRefresh((value) => value + 1)}>다시 시도</button></div>}
    {!items && !error && <p role="status">음원을 불러오는 중</p>}
    {items?.length === 0 && <div className="empty">
      <p className="muted">{search || archived ? "조건에 맞는 음원이 없습니다." : "WAV 또는 MP3 파일을 올려 검토를 시작하세요."}</p>
      {(search || archived) && <Link href={projectHref(projectId)}>필터 초기화</Link>}
    </div>}
    {items && items.length > 0 && <ul className="resource-list media-list">
      <li className="media-row muted media-columns" aria-hidden="true"><span>음원</span><span>최신 버전</span><span>상태</span><span>업로드</span></li>
      {items.map((item) => {
        const selected = item.latest_ready_id ?? item.latest?.id;
        const href = selected ? versionHref({ projectId, itemId: item.id, versionId: selected }) : itemHref(projectId, item.id);
        return <li className="media-row" key={item.id}>
          <Link className="resource-title" href={href}>{item.title}</Link>
          <span className="muted">{item.latest?.filename ?? "버전 없음"}</span>
          <span>{item.latest && <VersionStatus version={item.latest} />}</span>
          <span className="muted">{item.latest && <time dateTime={item.latest.created_at}>{uploadedAt.format(new Date(item.latest.created_at))}</time>}</span>
        </li>;
      })}
    </ul>}
    {more && <button disabled={loadingMore} onClick={() => void loadMore()}>음원 더 보기</button>}
  </>;
}

export function MediaDetail({ project, itemId, versionId, initialNote, initialAt, accountId }: {
  project: Project; itemId: string; versionId?: string; initialNote?: string; initialAt?: number; accountId: string;
}) {
  const { openUpload, uploadRevision } = useUpload();
  const router = useRouter();
  const base = "/v1/projects/" + project.id;
  const itemPath = base + "/media/" + encodeURIComponent(itemId);
  const [item, setItem] = useState<MediaItem>();
  const [version, setVersion] = useState<MediaVersion>();
  const [versions, setVersions] = useState<MediaVersion[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const canEdit = project.role !== "reviewer" && !project.archived_at;

  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const [media, history] = await Promise.all([
          api<MediaItem>(itemPath, { signal: request.signal }),
          api<MediaVersion[]>(itemPath + "/versions", { signal: request.signal }),
        ]);
        const selected = versionId ? await api<MediaVersion>(base + "/versions/" + encodeURIComponent(versionId), { signal: request.signal }) : undefined;
        if (request.signal.aborted) return;
        if (selected && selected.item_id !== media.id) {
          setError("이 음원의 버전이 아닙니다.");
          return;
        }

        const defaultVersion = media.latest_ready_id ?? media.latest?.id;
        if (!versionId && defaultVersion) {
          router.replace(versionHref({ projectId: project.id, itemId, versionId: defaultVersion }));
          return;
        }

        setItem(media);
        setVersion(selected);
        setVersions((previous) => [...history, ...previous.slice(pageSize).filter((row) => !history.some(({ id }) => id === row.id))]);
        setMore(history.length === pageSize);
        setError("");
        if (selected?.state === "queued" || selected?.state === "processing" ||
            media.latest?.state === "queued" || media.latest?.state === "processing") {
          timer = setTimeout(() => void load(), 2000);
        }
      } catch (cause) {
        if (!request.signal.aborted) setError(describeError(cause));
      }
    }

    void load();
    return () => { request.abort(); clearTimeout(timer); };
  }, [base, itemPath, itemId, project.id, refresh, router, uploadRevision, versionId]);

  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    const before = versions.at(-1)?.id;
    if (!before || busy) return;

    setBusy(true);
    try {
      const history = await api<MediaVersion[]>(itemPath + "/versions?before=" + before);
      setVersions((previous) => [...previous, ...history.filter((row) => !previous.some(({ id }) => id === row.id))]);
      setMore(history.length === pageSize);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  function canLeaveVersion() {
    if (!version) return true;
    const key = feedbackDraftKey(accountId, version.id);
    if (!readDraft(key, version.duration_ms ?? 0)?.body.trim()) return true;
    if (!window.confirm("작성 중인 피드백을 버리고 다른 버전을 열까요?")) return false;

    sessionStorage.removeItem(key);
    return true;
  }

  return <section aria-label="음원 상세">
    <Link href={projectHref(project.id)}>음원 목록</Link>
    {error && <div className="row wrap" role="alert"><span className="error">{error}</span>
      <button onClick={() => setRefresh((value) => value + 1)}>다시 시도</button></div>}
    {!item && !error && <p role="status">음원을 불러오는 중</p>}
    {item && <>
      <div className="row spread wrap section-header">
        <h2 className="section-title">{item.title}</h2>
        <div className="row wrap">
          {canEdit && !item.archived_at && <button className="primary" onClick={() => openUpload({ projectId: project.id, itemId })}>수정본 업로드</button>}
          {canEdit && <details className="inbox">
            <summary aria-label="음원 관리">관리</summary>
            <div className="inbox-body panel"><div className="row wrap">{version?.state === "ready" && <a className="button" href={base + "/versions/" + version.id + "/files/original"}>원본 다운로드</a>}<button disabled={busy} onClick={() => {
              if (!window.confirm(item.archived_at ? "음원을 복원할까요?" : "음원을 보관할까요?")) return;
              void change(() => api(itemPath, { method: "PATCH", body: JSON.stringify({ archived: !item.archived_at }) }));
            }}>{item.archived_at ? "음원 복원" : "음원 보관"}</button></div></div>
          </details>}
          {!canEdit && version?.state === "ready" && <a className="button" href={base + "/versions/" + version.id + "/files/original"}>원본 다운로드</a>}
        </div>
      </div>
      {item.archived_at && <p className="notice">보관된 음원입니다.</p>}
      {versions.length > 0 && <div className="row wrap version-picker">
        <label>버전 선택 <select value={versionId ?? ""} onChange={(event) => {
          if (canLeaveVersion()) router.push(versionHref({ projectId: project.id, itemId, versionId: event.target.value }));
        }}>
          {version && !versions.some(({ id }) => id === version.id) && <option value={version.id}>{version.filename}</option>}
          {versions.map((entry) => <option key={entry.id} value={entry.id}>{entry.filename} · {states[entry.state]} · {uploadedAt.format(new Date(entry.created_at))}</option>)}
        </select></label>
        {more && <button disabled={busy} onClick={() => void loadMore()}>이전 버전 더 보기</button>}
      </div>}
      {version && <p className="row wrap muted"><VersionStatus version={version} /><span>{version.filename} · {uploadedAt.format(new Date(version.created_at))}</span>
        {version.description && <span>{version.description}</span>}</p>}
      {item.latest && item.latest.id !== version?.id && <Link href={versionHref({ projectId: project.id, itemId, versionId: item.latest.id })} onNavigate={(event) => {
        if (!canLeaveVersion()) event.preventDefault();
      }}>최신 버전 {states[item.latest.state]} 보기</Link>}
      {version?.state === "ready" && <VersionReview key={version.id} base={base} version={version} initialAt={initialAt}
        initialNote={initialNote} projectId={project.id} accountId={accountId} canEdit={canEdit} writable={!project.archived_at && !item.archived_at} />}
      {(version?.state === "queued" || version?.state === "processing") && <p role="status">재생 준비 중입니다.</p>}
      {version?.state === "failed" && <div className="row wrap" role="status">
        <p className="error">{version.failure === "invalid_audio" ? "지원되는 파일 형식과 길이를 확인하고 수정본을 다시 올려 주세요." : "미디어를 처리하지 못했습니다."}</p>
        {canEdit && !item.archived_at && version.failure === "processing_failed" && <button disabled={busy} onClick={() => void change(
          () => api(base + "/versions/" + version.id + "/retry", { method: "POST" }),
        )}>처리 재시도</button>}
      </div>}
      {!version && <p className="muted">등록된 버전이 없습니다.</p>}
    </>}
  </section>;
}
