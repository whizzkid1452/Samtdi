"use client";

import { useEffect, useState } from "react";

type Anchor = { start_ms: number; end_ms?: number };
export type FeedbackDraft = { anchor: Anchor; body: string };

const unsavedDrafts = new Map<string, unknown>();

export function feedbackDraftKey(accountId: string, versionId: string) {
  return "samtdi-note:" + accountId + ":" + versionId;
}

function readStoredDraft(key: string): unknown {
  if (unsavedDrafts.has(key)) return unsavedDrafts.get(key);

  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

export function readFeedbackDraft({ key, duration }: { key: string; duration: number }): FeedbackDraft | null {
  const value = readStoredDraft(key);
  if (!value || typeof value !== "object" || !("body" in value) || typeof value.body !== "string" ||
    !("anchor" in value) || !value.anchor || typeof value.anchor !== "object") return null;

  const { anchor, body } = value;
  const start = "start_ms" in anchor ? anchor.start_ms : undefined;
  const end = "end_ms" in anchor ? anchor.end_ms : undefined;
  if (typeof start !== "number" || !Number.isInteger(start) || start < 0 || start > duration) return null;
  if (end === undefined) return { anchor: { start_ms: start }, body };
  if (typeof end !== "number" || !Number.isInteger(end) || end <= start || end > duration) return null;
  return { anchor: { start_ms: start, end_ms: end }, body };
}

export function readReplyDraft(key: string): string | null {
  const value = readStoredDraft(key);
  return typeof value === "string" ? value : null;
}

export function useFeedbackDraft<T>({ key, read }: { key: string; read: () => T | null }) {
  const [draft, setDraft] = useState(read);
  const [storageError, setStorageError] = useState(() => unsavedDrafts.has(key) && draft !== null);

  useEffect(() => {
    if (!storageError) return;

    function confirmExit(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = true;
    }

    window.addEventListener("beforeunload", confirmExit);
    return () => window.removeEventListener("beforeunload", confirmExit);
  }, [storageError]);

  function updateDraft(value: T | null) {
    setDraft(value);

    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
      unsavedDrafts.delete(key);
      setStorageError(false);
    } catch {
      unsavedDrafts.set(key, value);
      setStorageError(value !== null);
    }
  }

  return {
    draft, updateDraft,
    storageError: storageError ? "브라우저에 초안을 보관할 수 없습니다. 탭을 닫기 전에 피드백을 저장해 주세요." : "",
  };
}
