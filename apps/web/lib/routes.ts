export type ProjectTab = "media" | "tasks" | "activity" | "settings";

export function projectHref(projectId: string, tab: ProjectTab = "media") {
  return "/projects/" + encodeURIComponent(projectId) + "/" + tab;
}

export function itemHref(projectId: string, itemId: string) {
  return projectHref(projectId) + "/" + encodeURIComponent(itemId);
}

export function versionHref({ projectId, itemId, versionId, noteId, at }: {
  projectId: string; itemId: string; versionId: string; noteId?: string; at?: number;
}) {
  const query = new URLSearchParams();
  if (noteId) query.set("note", noteId);
  if (at !== undefined) query.set("at", String(at));
  const path = itemHref(projectId, itemId) + "/versions/" + encodeURIComponent(versionId);

  return query.size ? path + "?" + query : path;
}

export function taskHref(projectId: string, taskId: string) {
  return projectHref(projectId, "tasks") + "/" + encodeURIComponent(taskId);
}

export function versionLink(projectId: string, versionId: string, noteId?: string, at?: number) {
  const query = new URLSearchParams({ project: projectId, version: versionId });
  if (noteId) query.set("note", noteId);
  if (at !== undefined) query.set("at", String(at));
  return "/?" + query;
}
