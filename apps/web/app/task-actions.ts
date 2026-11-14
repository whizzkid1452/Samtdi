import { api, ApiError } from "../lib/api";
import type { Task, TaskChange } from "./task-editor";

export type TaskUpdate = TaskChange & { due_on?: string };

export function taskPayload(task: Task, change: TaskUpdate = {}) {
  return {
    title: task.title, description: task.description, status: task.status, assignee_id: task.assignee_id,
    due_on: task.due_on,
    result_version_id: task.result_version_id, review_text: task.review_text, archived: task.archived,
    revision: task.revision, note_ids: task.notes.map(({ id }) => id), confirm_notes: [], ...change,
  };
}

/**
 * Saves a board move (status, order, assignee, archive) straight away against the latest task.
 * Moves that need more input — a review request, or completing with unresolved feedback — return the
 * latest task so the caller can open the editor instead.
 */
export async function moveTask(base: string, id: string, change: TaskUpdate): Promise<{ saved: true } | { saved: false; task: Task }> {
  const path = base + "/tasks/" + encodeURIComponent(id);
  const latest = await api<Task>(path);
  if (change.status === "review" && latest.status !== "review") return { saved: false, task: latest };
  try {
    await api(path, { method: "PUT", body: JSON.stringify(taskPayload(latest, change)) });
    return { saved: true };
  } catch (cause) {
    if (cause instanceof ApiError && (cause.code === "unresolved_note_confirmation_required" || cause.code === "review_evidence_required")) {
      return { saved: false, task: latest };
    }
    throw cause;
  }
}

export async function createTask(base: string, task: { title: string; status: Task["status"]; assignee_id?: string; due_on?: string }) {
  return api<{ id: string }>(base + "/tasks", {
    method: "POST",
    body: JSON.stringify({
      description: "", assignee_id: "", due_on: "", result_version_id: "", review_text: "",
      archived: false, revision: 0, note_ids: [], confirm_notes: [], ...task,
    }),
  });
}
