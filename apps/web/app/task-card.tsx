"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { components } from "../lib/api-types";
import { versionHref } from "../lib/routes";
import type { Task } from "./task-editor";
import { DueChip, Icon, Person, Unassigned } from "./ui";
import type { Member } from "./workspace";

export type TaskSource = components["schemas"]["TaskSource"];

/** 83400 → 1:23 — whole seconds are enough to recognize a passage on a card. */
export function clock(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

export function sourceRange(source: Pick<TaskSource, "start_ms" | "end_ms">) {
  return clock(source.start_ms) + (source.end_ms == null ? "" : "–" + clock(source.end_ms));
}

/** Links a task back to the feedback it came from, opening the review at that passage. */
export function SourceChip({ projectId, source, filename = false }: { projectId: string; source: TaskSource; filename?: boolean }) {
  const href = versionHref({ projectId, itemId: source.item_id, versionId: source.version_id, noteId: source.note_id, at: source.start_ms });
  return <Link className="source-chip" href={href} draggable={false}
    aria-label={"원본 피드백: " + source.item_title + " " + source.filename + " " + sourceRange(source)}>
    <Icon name="music" size={14} />
    <span className="source-title">{source.item_title}</span>
    {filename && <span className="source-file">{source.filename}</span>}
    <span className="source-range">{sourceRange(source)}</span>
  </Link>;
}

export function Assignee({ members, id }: { members: Member[]; id?: string }) {
  const member = members.find(({ account_id }) => account_id === id);
  return member ? <Person id={member.account_id} person={member} /> : <Unassigned />;
}

export function FeedbackCount({ count }: { count: number }) {
  if (!count) return null;
  return <span className="meta-count" title={"연결 피드백 " + count + "개"}><Icon name="message" size={14} />{count}
    <span className="visually-hidden">개 피드백</span></span>;
}

/** The shared card body: title, the passage it came from, then who, when and how much feedback. */
export function TaskCardBody({ task, projectId, href, members, menu, project }: {
  task: Pick<Task, "id" | "title" | "status" | "assignee_id" | "due_on" | "notes" | "archived"> & { source?: TaskSource | null };
  projectId: string; href: string; members: Member[]; menu?: ReactNode; project?: string;
}) {
  return <>
    <div className="task-card-head">
      <Link href={href} className="resource-title task-card-title" draggable={false}>{task.title}</Link>
      {menu}
    </div>
    {project && <span className="muted small task-card-project">{project}</span>}
    {task.source && <SourceChip projectId={projectId} source={task.source} />}
    <div className="task-card-meta">
      <Assignee members={members} id={task.assignee_id} />
      <span className="row task-card-badges">
        <DueChip due={task.due_on} status={task.status} />
        <FeedbackCount count={task.notes.length} />
        {task.archived && <span className="status-label">보관됨</span>}
      </span>
    </div>
  </>;
}
