"use client";

import { Button, Textarea } from "@mantine/core";
import { useEffect, useRef, type FormEvent } from "react";
import { noteLabel } from "./version-notes";
import type { FeedbackDraft } from "./feedback-drafts";
import { submitFeedbackShortcut } from "./feedback-shortcut";
import { InlineError } from "./request-states";

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
      <Button type="button" variant="default" disabled={busy} onClick={moveAnchor}>현재 위치로 변경</Button>
    </div>
    <Textarea ref={input} w="100%" aria-label="피드백 내용" placeholder="이 부분에서 들은 내용을 남겨 주세요" maxLength={4000} readOnly={busy}
      value={draft.body} onChange={(event) => changeBody(event.target.value)} onKeyDown={submitFeedbackShortcut} required />
    {error && <InlineError message={error} />}
    <div className="row wrap">
      <Button type="submit" loading={busy} disabled={!draft.body.trim()}>피드백 저장</Button>
      <Button type="button" variant="default" disabled={busy} onClick={close}>작성 접기</Button>
      {draft.body.trim() && <Button type="button" variant="default" disabled={busy} onClick={discard}>초안 버리기</Button>}
    </div>
  </form>;
}
