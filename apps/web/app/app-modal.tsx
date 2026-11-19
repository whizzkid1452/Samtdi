"use client";

import { Modal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useLayoutEffect, type ReactNode } from "react";

export function AppModal({ title, children, close, returnFocusTo, busy = false }: {
  title: string;
  children: ReactNode;
  close: () => void;
  returnFocusTo?: HTMLElement | null;
  busy?: boolean;
}) {
  const fullScreen = useMediaQuery("(max-width: 700px)");

  useLayoutEffect(() => {
    const trigger = returnFocusTo ?? document.activeElement;

    // Callers unmount this modal on close, so there is no closed render for Mantine to restore focus.
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);

  return (
    <Modal
      opened
      onClose={close}
      title={title}
      size="34rem"
      centered
      fullScreen={fullScreen}
      closeOnClickOutside={false}
      closeOnEscape={!busy}
      closeButtonProps={{ "aria-label": "닫기", disabled: busy }}
      returnFocus={false}
    >
      {children}
    </Modal>
  );
}
