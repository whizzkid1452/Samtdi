"use client";

import { useLayoutEffect, useId, useRef, type ReactNode } from "react";

export function Dialog({ title, children, close, returnFocus }: { title: string; children: ReactNode; close: () => void; returnFocus?: HTMLElement | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = useId();

  useLayoutEffect(() => {
    const element = dialog.current;
    const trigger = returnFocus ?? document.activeElement;
    element?.showModal();
    element?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select")?.focus();

    return () => {
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [returnFocus]);

  return <dialog ref={dialog} className="dialog" aria-labelledby={label} onCancel={(event) => {
    event.preventDefault();
    close();
  }}>
    <div className="row spread">
      <h2 id={label}>{title}</h2>
      <button type="button" aria-label="닫기" onClick={close}>닫기</button>
    </div>
    {children}
  </dialog>;
}
