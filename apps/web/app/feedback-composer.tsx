"use client";

import { Button, Checkbox, Select, TextInput, Textarea } from "@mantine/core";
import { useEffect, useRef, type FormEvent } from "react";
import { displayName } from "../lib/people";
import type { Member } from "./workspace";
import { noteLabel } from "./version-notes";
import type { DraftTask, FeedbackDraft } from "./feedback-drafts";
import { submitFeedbackShortcut } from "./feedback-shortcut";
import { InlineError } from "./request-states";

export function FeedbackComposer({ draft, busy, error, save, close, discard, changeBody, moveAnchor, assignees, changeTask }: {
  draft: FeedbackDraft;
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
  const task = draft.task;
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
    {assignees && <fieldset className="feedback-task-fields">
      <legend>연결된 작업</legend>
      <Checkbox label="할 일로 만들기" checked={!!task} disabled={busy}
        onChange={(event) => changeTask(event.currentTarget.checked ? { assignee_id: "", due_on: "" } : undefined)} />
      {task && <div className="row wrap">
        <Select label="담당자" searchable clearable disabled={busy} placeholder="미할당" value={task.assignee_id || null}
          data={assignees.map((member) => ({ value: member.account_id, label: displayName(member) }))}
          onChange={(assignee) => changeTask({ ...task, assignee_id: assignee ?? "" })} />
        <TextInput label="마감일" type="date" disabled={busy} value={task.due_on}
          onChange={(event) => changeTask({ ...task, due_on: event.currentTarget.value })} />
      </div>}
    </fieldset>}
    {error && <InlineError message={error} />}
    <div className="row wrap">
      <Button type="submit" loading={busy} disabled={!draft.body.trim()}>피드백 저장</Button>
      <Button type="button" variant="default" disabled={busy} onClick={close}>작성 접기</Button>
      {draft.body.trim() && <Button type="button" variant="default" disabled={busy} onClick={discard}>초안 버리기</Button>}
    </div>
  </form>;
}
