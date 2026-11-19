"use client";

import { Alert, Button } from "@mantine/core";
import { useCallback, useRef, useState } from "react";
import { describeError } from "../lib/api";
import { AppModal } from "./app-modal";

export type Confirmation = {
  title: string;
  description: string;
  label: string;
  run: () => void | Promise<boolean | void>;
  trigger?: HTMLElement | null;
  focusAfterSuccess?: HTMLElement | null;
};

export function ConfirmAction({ confirmation, close, actionError }: {
  confirmation: Confirmation;
  close: () => void;
  actionError?: string;
}) {
  const executing = useRef(false);
  const confirmed = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const returnFocusTo = useCallback(() => {
    return confirmed.current
      ? confirmation.focusAfterSuccess ?? confirmation.trigger
      : confirmation.trigger;
  }, [confirmation]);

  async function accept() {
    if (executing.current) return;

    executing.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await confirmation.run();
      if (result === false) {
        setError("변경을 적용하지 못했습니다. 다시 시도해 주세요.");
        return;
      }

      confirmed.current = true;
      close();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      executing.current = false;
      setBusy(false);
    }
  }

  return (
    <AppModal title={confirmation.title} close={close} busy={busy} returnFocusTo={returnFocusTo} fullscreenOnMobile={false}>
      <p>{confirmation.description}</p>
      {error && <Alert color="red" role="alert">{actionError || error}</Alert>}
      <div className="row wrap confirm-actions">
        <Button type="button" variant="default" disabled={busy} data-autofocus onClick={close}>취소</Button>
        <Button type="button" color="red.8" loading={busy} onClick={() => void accept()}>{confirmation.label}</Button>
      </div>
    </AppModal>
  );
}
