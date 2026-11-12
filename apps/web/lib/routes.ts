export type ProjectTab = "media" | "tasks" | "activity" | "settings";

export function projectHref(projectId: string, tab: ProjectTab = "media") {
  return "/projects/" + encodeURIComponent(projectId) + "/" + tab;
}

export function versionHref({ projectId, itemId, versionId, noteId, at }: {
  projectId: string; itemId: string; versionId: string; noteId?: string; at?: number;
}) {
  const query = new URLSearchParams();
  if (noteId) query.set("note", noteId);
  if (at !== undefined) query.set("at", String(at));
  const path = projectHref(projectId) + "/" + encodeURIComponent(itemId) + "/versions/" + encodeURIComponent(versionId);

  return query.size ? path + "?" + query : path;
}
