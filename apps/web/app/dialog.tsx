"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

export function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = useId();

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

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
