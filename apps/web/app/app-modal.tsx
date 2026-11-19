"use client";

import { Modal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useLayoutEffect, type ReactNode } from "react";

export function AppModal({ title, children, close, returnFocusTo, busy = false, suspended = false, fullscreenOnMobile = true }: {
  title: string;
  children: ReactNode;
  close: () => void;
  returnFocusTo?: HTMLElement | null | (() => HTMLElement | null | undefined);
  busy?: boolean;
  suspended?: boolean;
  fullscreenOnMobile?: boolean;
}) {
  const fullScreen = useMediaQuery("(max-width: 700px)");

  useLayoutEffect(() => {
    const previousFocus = document.activeElement;

    // Callers unmount this modal on close, so there is no closed render for Mantine to restore focus.
    return () => {
      const assignedTarget = typeof returnFocusTo === "function" ? returnFocusTo() : returnFocusTo;
      const target = assignedTarget?.isConnected ? assignedTarget : previousFocus;
      if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);

  return (
    <Modal
      opened
      onClose={close}
      title={title}
      size="34rem"
      centered
      fullScreen={fullscreenOnMobile && fullScreen}
      inert={suspended}
      trapFocus={!suspended}
      closeOnClickOutside={false}
      closeOnEscape={!busy && !suspended}
      closeButtonProps={{ "aria-label": "닫기", disabled: busy }}
      returnFocus={false}
    >
      {children}
    </Modal>
  );
}
