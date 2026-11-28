"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LocalWorkspace } from "./local-workspace";
import { Workspace } from "./workspace";

export function WorkspaceShell({ children, local, guideHref }: { children: ReactNode; local: boolean; guideHref?: string }) {
  const pathname = usePathname();

  if (pathname === "/oauth/consent") return children;

  return local ? <LocalWorkspace guideHref={guideHref} /> : <Workspace guideHref={guideHref}>{children}</Workspace>;
}
