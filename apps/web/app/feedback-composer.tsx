"use client";

import { useEffect, useRef, type FormEvent } from "react";
import { displayName } from "../lib/people";
import { noteLabel } from "./version-notes";
import type { DraftTask, FeedbackDraft } from "./feedback-drafts";
import type { Member } from "./workspace";

import { submitFeedbackShortcut } from "./feedback-shortcut";

export function FeedbackComposer({ draft, busy, error, save, close, discard, changeBody, moveAnchor, assignees, changeTask }: {
  draft: FeedbackDraft;
  /** People who can own a task; when given, the feedback can also become a to-do. */
  assignees?: Member[];
  changeTask: (task: DraftTask | undefined) => void;
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
    <textarea ref={input} aria-label="피드백 내용" placeholder="이 부분에서 들은 내용을 남겨 주세요" maxLength={4000} readOnly={busy}
      value={draft.body} onChange={(event) => changeBody(event.target.value)} onKeyDown={submitFeedbackShortcut} required />
    {assignees && <fieldset className="task-option">
      <legend className="visually-hidden">할 일 연결</legend>
      <label className="row task-option-toggle"><input type="checkbox" checked={!!draft.task} disabled={busy}
        onChange={(event) => changeTask(event.target.checked ? { assignee_id: "", due_on: "" } : undefined)} />할 일로 만들기</label>
      {draft.task && <div className="row wrap task-option-fields">
        <label>담당<select value={draft.task.assignee_id} disabled={busy} onChange={(event) => changeTask({ ...draft.task!, assignee_id: event.target.value })}>
          <option value="">미할당</option>
          {assignees.map((member) => <option key={member.account_id} value={member.account_id}>{displayName(member)}</option>)}
        </select></label>
        <label>마감<input type="date" value={draft.task.due_on} disabled={busy} onChange={(event) => changeTask({ ...draft.task!, due_on: event.target.value })} /></label>
        <p className="muted small">저장하면 할 일 열에 작업이 생기고{draft.task.assignee_id ? " 담당자에게 알림이 갑니다." : " 담당자는 나중에 정할 수 있습니다."}</p>
      </div>}
    </fieldset>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="row wrap">
      <button className="primary" disabled={busy || !draft.body.trim()}>피드백 저장</button>
      <button type="button" disabled={busy} onClick={close}>작성 접기</button>
      {draft.body.trim() && <button type="button" disabled={busy} onClick={discard}>초안 버리기</button>}
    </div>
  </form>;
}
