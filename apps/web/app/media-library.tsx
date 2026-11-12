"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import type { Project } from "./workspace";

type MediaItem = { id: string; title: string; archived_at?: string };
export type MediaVersion = {
  id: string;
  item_id: string;
  filename: string;
  description: string;
  state: "queued" | "processing" | "ready" | "failed";
  duration_ms?: number;
  failure?: string;
  created_at: string;
};
type Upload = { id: string; url: string; headers: Record<string, string[]> };

const states = { queued: "처리 대기", processing: "처리 중", ready: "재생 가능", failed: "처리 실패" };

export function MediaLibrary({ project, initialVersion }: { project: Project; initialVersion?: string }) {
  const base = `/v1/projects/${project.id}`;
  const [items, setItems] = useState<MediaItem[]>([]);
  const [itemId, setItemId] = useState("");
  const [versions, setVersions] = useState<MediaVersion[]>([]);
  const [versionId, setVersionId] = useState(initialVersion ?? "");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number>();
  const [pendingCompletion, setPendingCompletion] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const uploadRequest = useRef<XMLHttpRequest | null>(null);
  const item = items.find((candidate) => candidate.id === itemId);
  const version = versions.find((candidate) => candidate.id === versionId);
  const canEdit = project.role !== "reviewer" && !project.archived_at;

  useEffect(() => {
    const request = new AbortController();
    async function load() {
      try {
        const nextItems = await api<MediaItem[]>(base + "/media", { signal: request.signal });
        const linked = initialVersion ? await api<MediaVersion>(base + "/versions/" + encodeURIComponent(initialVersion), {
          signal: request.signal,
        }).catch(() => null) : null;
        if (request.signal.aborted) return;
        setItems(nextItems);
        setItemId(linked?.item_id ?? nextItems[0]?.id ?? "");
      } catch (cause) {
        if (!request.signal.aborted) setError(describeError(cause));
      }
    }
    void load();
    return () => {
      request.abort();
      uploadRequest.current?.abort();
    };
  }, [base, initialVersion]);

  useEffect(() => {
    if (!itemId) return;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const result = await api<MediaVersion[]>(base + "/media/" + itemId + "/versions", { signal: request.signal });
        if (request.signal.aborted) return;
        setVersions(result);
        setVersionId((previous) => result.some((entry) => entry.id === previous) ? previous : result[0]?.id ?? "");
        if (result.some(({ state }) => state === "queued" || state === "processing")) {
          timer = setTimeout(() => void load(), 2000);
        }
      } catch (cause) {
        if (!request.signal.aborted) setError(describeError(cause));
      }
    }
    void load();
    return () => { request.abort(); clearTimeout(timer); };
  }, [base, itemId, pollRevision]);

  async function run(change: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await change(); }
    catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  }

  function selectItem(nextItemId: string) {
    setItemId(nextItemId);
    setVersions([]);
    setVersionId("");
  }

  async function createItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = new FormData(form).get("title");
    await run(async () => {
      const created = await api<MediaItem>(base + "/media", { method: "POST", body: JSON.stringify({ title }) });
      setItems((previous) => [created, ...previous]);
      selectItem(created.id);
      form.reset();
    });
  }

  async function complete(id: string) {
    const created = await api<MediaVersion>(base + "/uploads/" + id + "/complete", {
      method: "POST", headers: { "Idempotency-Key": id },
    });
    setPendingCompletion(undefined);
    setVersions((previous) => [created, ...previous.filter(({ id }) => id !== created.id)]);
    setVersionId(created.id);
    setPollRevision((value) => value + 1);
  }

  async function uploadFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || !file.size) return;

    await run(async () => {
      try {
        setProgress(0);
        const upload = await api<Upload>(base + "/media/" + itemId + "/uploads", {
          method: "POST", body: JSON.stringify({ filename: file.name, bytes: file.size, description: data.get("description") }),
        });
        await new Promise<void>((resolve, reject) => {
          const request = new XMLHttpRequest();
          uploadRequest.current = request;
          request.open("PUT", upload.url);
          for (const [name, values] of Object.entries(upload.headers)) request.setRequestHeader(name, values.join(", "));
          request.upload.onprogress = (event) => {
            if (event.lengthComputable) setProgress(event.loaded / event.total * 100);
          };
          request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error("upload failed"));
          request.onerror = () => reject(new Error("upload interrupted"));
          request.onabort = () => reject(new Error("upload cancelled"));
          request.send(file);
        });
        setPendingCompletion(upload.id);
        await complete(upload.id);
        form.reset();
      } finally {
        uploadRequest.current = null;
        setProgress(undefined);
      }
    });
  }

  return (
    <section className="panel" aria-label="음원과 버전">
      <h2>음원과 버전</h2>
      {error && <p role="alert" className="error">{error}</p>}
      {canEdit && <form className="row wrap" onSubmit={createItem}>
        <input aria-label="새 음원 이름" name="title" placeholder="새 음원 이름" required maxLength={160} />
        <button disabled={busy}>음원 추가</button>
      </form>}
      {items.length === 0 && <p className="muted">등록된 음원이 없습니다.</p>}
      {items.length > 0 && <div className="row wrap">
        <select aria-label="음원 선택" disabled={busy || !!pendingCompletion} value={itemId} onChange={(event) => selectItem(event.target.value)}>
          {items.map((item) => <option key={item.id} value={item.id}>{item.title}{item.archived_at ? " · 보관됨" : ""}</option>)}
        </select>
        {canEdit && item && <button disabled={busy} onClick={() => void run(async () => {
          await api(base + "/media/" + itemId, { method: "PATCH", body: JSON.stringify({ archived: !item.archived_at }) });
          setItems(await api(base + "/media"));
        })}>{item.archived_at ? "음원 복원" : "음원 보관"}</button>}
      </div>}
      {canEdit && item && !item.archived_at && <form className="upload-form" onSubmit={uploadFile}>
        <label>WAV 또는 MP3<input name="file" type="file" accept=".wav,.mp3,audio/wav,audio/mpeg" required /></label>
        <label>수정 설명<input name="description" maxLength={2000} /></label>
        <div className="row wrap">
          <button className="primary" disabled={busy || !!pendingCompletion}>버전 업로드</button>
          {progress !== undefined && <><progress aria-label="업로드 진행률" value={progress} max={100} />
            <button type="button" onClick={() => uploadRequest.current?.abort()}>전송 중단</button></>}
          {pendingCompletion && <button type="button" disabled={busy} onClick={() => void run(() => complete(pendingCompletion))}>버전 등록 재시도</button>}
        </div>
      </form>}
      {versions.length > 0 && <label>버전 선택<select value={versionId} onChange={(event) => setVersionId(event.target.value)}>
        {versions.map((entry) => <option key={entry.id} value={entry.id}>{entry.filename} · {states[entry.state]}</option>)}
      </select></label>}
      {version && <p role="status">{states[version.state]}{version.description ? " · " + version.description : ""}</p>}
      {version?.state === "failed" && <div className="row wrap">
        <p className="muted">{version.failure === "invalid_audio" ? "지원되는 형식과 길이를 확인해 주세요." : "미디어를 처리하지 못했습니다."}</p>
        {canEdit && version.failure === "processing_failed" && <button disabled={busy} onClick={() => void run(async () => {
          await api(base + "/versions/" + version.id + "/retry", { method: "POST" });
          setPollRevision((value) => value + 1);
        })}>처리 재시도</button>}
      </div>}

    </section>
  );
}
