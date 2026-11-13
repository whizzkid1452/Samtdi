import { notFound, redirect } from "next/navigation";
import { ProjectIndex, ProjectScreen } from "../../project-screen";
import { projectHref } from "../../../lib/routes";

export default async function Projects({ params }: { params: Promise<{ route?: string[] }> }) {
  const { route } = await params;
  if (!route) return <ProjectIndex />;

  const [projectId, tab, itemId, section, versionId] = route;
  if (route.length === 1) redirect(projectHref(projectId));
  if (route.length === 2 && (tab === "media" || tab === "tasks" || tab === "activity" || tab === "settings")) {
    return <ProjectScreen projectId={projectId} tab={tab} />;
  }
  if (route.length === 5 && tab === "media" && itemId && section === "versions") {
    return <ProjectScreen projectId={projectId} tab={tab} versionId={versionId} />;
  }
  notFound();
}
