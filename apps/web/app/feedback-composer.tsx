"use client";

import { useEffect, useRef, type FormEvent } from "react";
import { noteLabel } from "./version-notes";
import type { FeedbackDraft } from "./feedback-drafts";

import { submitFeedbackShortcut } from "./feedback-shortcut";

export function FeedbackComposer({ draft, busy, error, save, close, discard, changeBody, moveAnchor }: {
  draft: FeedbackDraft;
  busy: boolean;
  error: string;
  save: (event: FormEvent<HTMLFormElement>) => void;
  close: () => void;
  discard: () => void;
  changeBody: (body: string) => void;
  moveAnchor: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  return <form className="notes-form" aria-label="피드백 남기기" onSubmit={save} onKeyDown={(event) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing && !busy) {
      event.stopPropagation();
      close();
    }
  }}>
    <div className="row wrap spread">
      <strong className="feedback-time">{noteLabel(draft.anchor)}</strong>
      <button type="button" disabled={busy} onClick={moveAnchor}>현재 위치로 변경</button>
    </div>
    <textarea ref={input} aria-label="피드백 내용" placeholder="이 부분에서 들은 내용을 남겨 주세요" maxLength={4000}
      value={draft.body} onChange={(event) => changeBody(event.target.value)} onKeyDown={submitFeedbackShortcut} required />
    {error && <p role="alert" className="error">{error}</p>}
    <div className="row wrap">
      <button className="primary" disabled={busy || !draft.body.trim()}>피드백 저장</button>
      <button type="button" disabled={busy} onClick={close}>작성 접기</button>
      {draft.body.trim() && <button type="button" disabled={busy} onClick={discard}>초안 버리기</button>}
    </div>
  </form>;
}
