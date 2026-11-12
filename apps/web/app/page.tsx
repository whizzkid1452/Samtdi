import { Workspace } from "./workspace";

export default async function Home({ searchParams }: {
  searchParams: Promise<{ project?: string; version?: string; note?: string; at?: string; task_note?: string }>;
}) {
  return <Workspace initial={await searchParams} />;
}
