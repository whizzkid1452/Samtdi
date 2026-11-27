"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LocalWorkspace } from "./local-workspace";
import { Workspace } from "./workspace";

export function WorkspaceShell({ children, local }: { children: ReactNode; local: boolean }) {
  const pathname = usePathname();
  if (pathname === "/oauth/consent") return children;
  return local ? <LocalWorkspace /> : <Workspace>{children}</Workspace>;
}
