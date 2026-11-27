"use client";

import { Button, FileInput, Progress, Textarea, TextInput } from "@mantine/core";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { itemHref, projectHref, versionHref } from "../lib/routes";
import { AppModal } from "./app-modal";
import { ConfirmAction, type Confirmation } from "./confirm-action";
import { InlineError } from "./request-states";

type MediaVersion = components["schemas"]["MediaVersion"];
type UploadSession = components["schemas"]["UploadSession"];
type Draft = { projectId: string; itemId: string; isNew: boolean; title: string; description: string; file?: File };
type Completion = { projectId: string; id: string };
type UploadStage = "prepare" | "transfer" | "register";

const UploadContext = createContext<{
  openUpload: (target: { projectId: string; itemId?: string; file?: File }) => void;
  uploadRevision: number;
} | null>(null);

export function useUpload() {
  const context = useContext(UploadContext);
  if (!context) throw new Error("Upload controls are unavailable");
  return context;
}

function suggestedTitle(file: File) {
  return file.name.replace(/\.(wav|mp3)$/i, "").trim().slice(0, 160);
}

function loadCompletion(key: string): Completion | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as Completion | null;
    const uuid = /^[0-9a-f-]{36}$/;
    return saved && uuid.test(saved.projectId) && uuid.test(saved.id) ? saved : null;
  } catch {
    return null;
  }
}

function transferFile({ upload, file, signal, onProgress }: {
  upload: UploadSession; file: File; signal: AbortSignal; onProgress: (value: number) => void;
}) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const request = new XMLHttpRequest();
    const cancel = () => request.abort();
    request.open("PUT", upload.url);
    for (const [name, values] of Object.entries(upload.headers)) request.setRequestHeader(name, values.join(", "));

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error("transfer_failed"));
    request.onerror = () => reject(new Error("transfer_failed"));
    request.onabort = () => reject(signal.reason);
    request.onloadend = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    request.send(file);
  });
}

export function UploadProvider({ accountId, children }: { accountId: string; children: ReactNode }) {
  const storageKey = "samtdi-upload:" + accountId;
  const router = useRouter();
  const pathname = usePathname();
  const currentPath = useRef(pathname);
  const request = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [completion, setCompletion] = useState(() => loadCompletion(storageKey));
  const [stage, setStage] = useState<UploadStage>();
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);
  const [completed, setCompleted] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [uploadRevision, setUploadRevision] = useState(0);

  useEffect(() => { currentPath.current = pathname; }, [pathname]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!draft?.file && !stage) return;

    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft?.file, stage]);

  function rememberCompletion(value: Completion | null) {
    setCompletion(value);
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
  }

  async function register(pending: Completion, signal: AbortSignal) {
    const base = "/v1/projects/" + pending.projectId;
    let version: MediaVersion;
    try {
      version = await api<MediaVersion>(base + "/versions/" + pending.id, { signal });
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.status !== 404) throw cause;
      version = await api<MediaVersion>(base + "/uploads/" + pending.id + "/complete", {
        signal, method: "POST", headers: { "Idempotency-Key": pending.id },
      });
    }

    const href = versionHref({ projectId: pending.projectId, itemId: version.item_id, versionId: version.id });
    rememberCompletion(null);
    setDraft(null);
    setVisible(false);
    setCompleted(href);
    setUploadRevision((value) => value + 1);
    const projectPath = projectHref(pending.projectId);
    const reviewPath = itemHref(pending.projectId, version.item_id) + "/versions/";
    if (currentPath.current.startsWith(projectPath) && !currentPath.current.startsWith(reviewPath)) router.push(href);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (request.current) return;

    const file = draft?.file;
    if (!completion && (!draft || !file || !/\.(wav|mp3)$/i.test(file.name) || !file.size || file.size > (process.env.NEXT_PUBLIC_SAMTDI_FREE_STORAGE === "1" ? 45_000_000 : 500_000_000))) {
      setError(process.env.NEXT_PUBLIC_SAMTDI_FREE_STORAGE === "1"
        ? "45 MB 이하의 WAV 또는 MP3 파일을 선택해 주세요. 변환 후 WAV도 45 MB 이하여야 합니다."
        : "500 MB 이하의 WAV 또는 MP3 파일을 선택해 주세요.");
      return;
    }

    const operation = new AbortController();
    request.current = operation;
    setError("");
    setProgress(0);
    try {
      if (completion) {
        setStage("register");
        await register(completion, operation.signal);
      } else if (draft && file) {
        const base = "/v1/projects/" + draft.projectId;
        setStage("prepare");
        if (draft.isNew) {
          await api(base + "/media", {
            signal: operation.signal, method: "POST", body: JSON.stringify({ id: draft.itemId, title: draft.title }),
          });
          setDraft({ ...draft, isNew: false });
          setUploadRevision((value) => value + 1);
        }

        const upload = await api<UploadSession>(base + "/media/" + draft.itemId + "/uploads", {
          signal: operation.signal, method: "POST",
          body: JSON.stringify({ filename: file.name, bytes: file.size, description: draft.description }),
        });
        setStage("transfer");
        await transferFile({ upload, file, signal: operation.signal, onProgress: setProgress });

        const pending = { projectId: draft.projectId, id: upload.id };
        rememberCompletion(pending);
        setStage("register");
        await register(pending, operation.signal);
      }
    } catch (cause) {
      setError(operation.signal.aborted ? "전송을 취소했습니다. 파일을 다시 전송할 수 있습니다." :
        cause instanceof Error && cause.message === "transfer_failed" ? "파일 전송에 실패했습니다. 다시 시도해 주세요." : describeError(cause));
    } finally {
      request.current = null;
      setStage(undefined);
    }
  }

  function openUpload({ projectId, itemId, file }: { projectId: string; itemId?: string; file?: File }) {
    if (!draft && !completion && !request.current) {
      setDraft({ projectId, itemId: itemId ?? crypto.randomUUID(), isNew: !itemId, title: file ? suggestedTitle(file) : "", description: "", file });
      setError("");
      setCompleted("");
    }
    setVisible(true);
  }

  function discardUpload() {
    setDraft(null);
    rememberCompletion(null);
    setVisible(false);
  }

  const stageLabel = stage === "prepare" ? "업로드 준비 중" : stage === "transfer" ? "전송 중" : "버전 등록 중";

  const transferProgress = stage === "transfer" && <Progress className="upload-progress" aria-label="업로드 진행률" value={progress} size="sm" />;

  return <UploadContext.Provider value={{ openUpload, uploadRevision }}>
    {children}
    {!visible && (draft || completion || completed) && <div className="upload-status" role="status">
      {completed ? <>
        <Button component={Link} href={completed}>업로드한 버전 열기</Button>
        <Button variant="default" onClick={() => setCompleted("")}>닫기</Button>
      </> : <>
        <Button variant="default" onClick={() => setVisible(true)}>
          {stage ? stageLabel : completion ? "버전 등록 이어가기" : "업로드 열기"}
        </Button>
        {transferProgress}
      </>}
    </div>}
    {visible && (draft || completion) && <AppModal title={completion ? "버전 등록" : draft?.isNew ? "음원 업로드" : "수정본 업로드"} close={() => setVisible(false)} suspended={!!confirmation}>
      <form className="upload-form" onSubmit={submit}>
        {draft && !completion && <>
          <FileInput label="WAV 또는 MP3" placeholder="파일 선택" data-autofocus={!stage || undefined}
            fileInputProps={{ "aria-label": "오디오 파일 입력" }} name="file" accept=".wav,.mp3" disabled={!!stage}
            value={draft.file ?? null} onChange={(file) => {
              setDraft({ ...draft, file: file ?? undefined, title: draft.title || (file ? suggestedTitle(file) : "") });
            }} />
          {draft.isNew && <TextInput label="음원 이름" name="title" required maxLength={160} disabled={!!stage}
            value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })} />}
          <Textarea label="수정 설명 (선택)" name="description" maxLength={2000} disabled={!!stage}
            value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })} />
        </>}
        {error && <InlineError message={error} />}
        {stage && <p role="status">{stageLabel}</p>}
        {transferProgress}
        <div className="row wrap">
          <Button type="submit" loading={!!stage} disabled={!completion && !draft?.file}>{completion ? "등록 계속하기" : "파일 업로드"}</Button>
          {stage && <Button type="button" variant="default" onClick={() => setVisible(false)}>백그라운드에서 계속</Button>}
          {stage === "transfer" && <Button type="button" variant="default" onClick={(event) => {
            const transfer = request.current;
            if (!transfer) return;

            setConfirmation({
              title: "파일 전송 취소",
              description: "전송을 중단할까요? 선택한 파일과 입력 내용은 유지됩니다.",
              label: "전송 취소",
              trigger: event.currentTarget,
              run: () => {
                if (request.current === transfer) transfer.abort();
              },
            });
          }}>전송 취소</Button>}
          {!stage && <Button type="button" variant="default" onClick={(event) => {
            if (!draft?.file && !completion) {
              discardUpload();
              return;
            }

            setConfirmation({
              title: "업로드 그만두기",
              description: "선택한 파일과 등록 정보를 지울까요?",
              label: "그만두기",
              trigger: event.currentTarget,
              run: discardUpload,
            });
          }}>그만두기</Button>}
        </div>
      </form>
    </AppModal>}
    {confirmation && <ConfirmAction confirmation={confirmation} close={() => setConfirmation(undefined)} />}
  </UploadContext.Provider>;
}
