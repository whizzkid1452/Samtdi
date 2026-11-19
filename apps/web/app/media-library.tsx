"use client";

import { Alert, Badge, Button, Checkbox, Collapse, Menu, Table, TextInput } from "@mantine/core";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { itemHref, projectHref, versionHref } from "../lib/routes";
import { useUpload } from "./upload";
import { ActionMenu } from "./action-menu";
import { ConfirmAction, type Confirmation } from "./confirm-action";
import { VersionReview } from "./version-review";
import type { Project } from "./workspace";
import { EmptyState, InlineError, LoadingRows } from "./request-states";

type MediaItem = components["schemas"]["MediaItem"];
export type MediaVersion = components["schemas"]["MediaVersion"];

const states: Record<MediaVersion["state"], string> = { queued: "처리 대기", processing: "처리 중", ready: "재생 가능", failed: "처리 실패" };
const stateColors: Record<MediaVersion["state"], string> = { queued: "gray", processing: "blue", ready: "samtdi", failed: "red" };
const uploadedAt = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });
const pageSize = 100;

function VersionStatus({ version }: { version: MediaVersion }) {
  return <Badge variant="light" tt="none" color={stateColors[version.state]}>{states[version.state]}</Badge>;
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
      {canEdit && <Button onClick={() => openUpload({ projectId: project.id })}>음원 업로드</Button>}
    </div>
    <form className="row wrap filter-bar" onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      filter(search, archived);
    }}>
      <TextInput type="search" aria-label="음원 검색" placeholder="음원 검색" maxLength={200} value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
      <Button type="submit" variant="default">검색</Button>
      <Checkbox label="보관된 음원" checked={archived}
        onChange={(event) => filter(query.get("q") ?? "", event.currentTarget.checked)} />
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
    {error && <InlineError message={error} retry={() => { setError(""); setRefresh((value) => value + 1); }} />}
    {!items && !error && <LoadingRows label="음원을 불러오는 중" />}
    {items?.length === 0 && (
      <EmptyState message={search || archived ? "조건에 맞는 음원이 없습니다." : "WAV 또는 MP3 파일을 올려 검토를 시작하세요."}>
        {(search || archived) && <Link href={projectHref(projectId)}>필터 초기화</Link>}
      </EmptyState>
    )}
    {items && items.length > 0 && (
      <Table className="media-table" role="table" aria-label="음원과 최신 버전" withTableBorder layout="fixed" highlightOnHover>
        <Table.Thead role="rowgroup">
          <Table.Tr role="row">
            <Table.Th scope="col">음원</Table.Th>
            <Table.Th scope="col">최신 버전</Table.Th>
            <Table.Th scope="col">상태</Table.Th>
            <Table.Th scope="col">업로드</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody role="rowgroup">
          {items.map((item) => {
            const selected = item.latest_ready_id ?? item.latest?.id;
            const href = selected ? versionHref({ projectId, itemId: item.id, versionId: selected }) : itemHref(projectId, item.id);

            return (
              <Table.Tr key={item.id} role="row">
                <Table.Td role="cell"><Link className="resource-title" href={href}>{item.title}</Link></Table.Td>
                <Table.Td role="cell" className="muted">{item.latest?.filename ?? "버전 없음"}</Table.Td>
                <Table.Td role="cell">{item.latest && <VersionStatus version={item.latest} />}</Table.Td>
                <Table.Td role="cell" className="muted">
                  {item.latest && <time dateTime={item.latest.created_at}>{uploadedAt.format(new Date(item.latest.created_at))}</time>}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    )}
    {more && <Button variant="default" loading={loadingMore} onClick={() => void loadMore()}>음원 더 보기</Button>}
  </>;
}

export function MediaDetail({ project, itemId, versionId, initialNote, initialAt, accountId }: {
  project: Project; itemId: string; versionId?: string; initialNote?: string; initialAt?: number; accountId: string;
}) {
  const { openUpload, uploadRevision } = useUpload();
  const router = useRouter();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyId = useId();
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
      return true;
    } catch (cause) {
      setError(describeError(cause));
      return false;
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

  return <section aria-label="음원 상세">
    <Link href={projectHref(project.id)}>음원 목록</Link>
    {error && <InlineError message={error} retry={() => { setError(""); setRefresh((value) => value + 1); }} />}
    {!item && !error && <LoadingRows label="음원을 불러오는 중" />}
    {item && <>
      <div className="row spread wrap section-header review-header">
        <h2 className="section-title">{item.title}</h2>
        <div className="row wrap">
          {canEdit && !item.archived_at && <Button variant="default" onClick={() => openUpload({ projectId: project.id, itemId })}>수정본 업로드</Button>}
          {canEdit && <ActionMenu label="관리" accessibleName="음원 관리">{(trigger) => <>
            {version?.state === "ready" && (
              <Menu.Item component="a" href={base + "/versions/" + version.id + "/files/original"}>원본 다운로드</Menu.Item>
            )}
            <Menu.Item disabled={busy} onClick={() => {
              const archived = !item.archived_at;
              const label = archived ? "보관" : "복원";
              setConfirmation({
                title: "음원 " + label,
                description: item.title + " 음원을 " + label + "할까요?",
                label,
                trigger: trigger.current,
                run: () => change(() => api(itemPath, { method: "PATCH", body: JSON.stringify({ archived }) })),
              });
            }}>{item.archived_at ? "음원 복원" : "음원 보관"}</Menu.Item>
          </>}</ActionMenu>}
          {!canEdit && version?.state === "ready" && <Button component="a" variant="default" href={base + "/versions/" + version.id + "/files/original"}>원본 다운로드</Button>}
        </div>
      </div>
      {confirmation && <ConfirmAction confirmation={confirmation} actionError={error} close={() => setConfirmation(undefined)} />}
      {item.archived_at && <Alert color="gray">보관된 음원입니다.</Alert>}
      {version && <div className="version-overview">
        <div className="row wrap">
          <strong>{version.filename}</strong>
          <VersionStatus version={version} />
          <time className="muted" dateTime={version.created_at}>{uploadedAt.format(new Date(version.created_at))}</time>
          {item.latest_ready_id === version.id && <Badge variant="outline" tt="none">최신 재생 가능 버전</Badge>}
          {version.state === "ready" && item.latest_ready_id && item.latest_ready_id !== version.id &&
            <Link href={versionHref({ projectId: project.id, itemId, versionId: item.latest_ready_id })}>최신 재생 가능 버전 열기</Link>}
        </div>
        {version.description && <p className="review-description muted">{version.description}</p>}
        {item.latest_ready_id && version.state === "ready" && item.latest_ready_id !== version.id &&
          <p className="muted review-description">이전 버전 검토 중</p>}
        {item.latest && item.latest.id !== version.id && item.latest.state !== "ready" &&
          <p className="review-description"><Link href={versionHref({ projectId: project.id, itemId, versionId: item.latest.id })}>
            최신 버전 {states[item.latest.state]} 보기
          </Link></p>}
        {versions.length > 0 && <div className="version-history">
          <Button variant="default" aria-expanded={historyOpen} aria-controls={historyId}
            onClick={() => setHistoryOpen((open) => !open)}>버전 기록</Button>
          <Collapse id={historyId} expanded={historyOpen}>
            <ul className="clean-list">
              {versions.map((entry) => <li key={entry.id}>
                <Link href={versionHref({ projectId: project.id, itemId, versionId: entry.id })}
                  aria-current={entry.id === version.id ? "page" : undefined}>
                  <strong>{entry.filename}</strong>
                  <span className="muted">{uploadedAt.format(new Date(entry.created_at))}</span>
                  <VersionStatus version={entry} />
                  {entry.id === version.id && <Badge variant="outline" tt="none">현재 버전</Badge>}
                </Link>
                {entry.description && <p className="review-description muted">{entry.description}</p>}
              </li>)}
            </ul>
            {more && <Button variant="default" loading={busy} onClick={() => void loadMore()}>이전 버전 더 보기</Button>}
          </Collapse>
        </div>}
      </div>}
      {version?.state === "ready" && <VersionReview key={version.id} base={base} version={version} initialAt={initialAt}
        initialNote={initialNote} projectId={project.id} accountId={accountId} canEdit={canEdit} writable={!project.archived_at && !item.archived_at} />}
      {(version?.state === "queued" || version?.state === "processing") && <Alert color="gray" role="status">재생 준비 중입니다.</Alert>}
      {version?.state === "failed" && <InlineError
        message={version.failure === "invalid_audio"
          ? "지원되는 파일 형식과 길이를 확인하고 수정본을 다시 올려 주세요."
          : "미디어를 처리하지 못했습니다."}
        retryLabel="처리 재시도"
        retrying={busy}
        retry={canEdit && !item.archived_at && version.failure === "processing_failed"
          ? () => void change(() => api(base + "/versions/" + version.id + "/retry", { method: "POST" }))
          : undefined} />}
      {!version && <p className="muted">등록된 버전이 없습니다.</p>}
    </>}
  </section>;
}
