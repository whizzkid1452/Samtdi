"use client";

import { Button, Menu } from "@mantine/core";
import { useRef, type ReactNode, type RefObject } from "react";

export function ActionMenu({ label, accessibleName, children }: {
  label: string;
  accessibleName?: string;
  children: (trigger: RefObject<HTMLButtonElement | null>) => ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <Menu position="bottom-end" shadow="sm">
      <Menu.Target>
        <Button ref={trigger} type="button" size="compact-sm" variant="default" aria-label={accessibleName}>
          {label}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>{children(trigger)}</Menu.Dropdown>
    </Menu>
  );
}
