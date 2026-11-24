"use client";

import { Button, TextInput } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { AppModal } from "./app-modal";
import { InlineError } from "./request-states";

export function AccountProfile({ name, close, saved }: {
  name: string;
  close: () => void;
  saved: (session: components["schemas"]["Session"]) => void;
}) {
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    setError("");
    try {
      const session = await api<components["schemas"]["Session"]>("/v1/me", {
        method: "PATCH",
        body: JSON.stringify({ name: draft }),
      });
      saved(session);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  }

  return <AppModal title="표시 이름 변경" close={close} busy={saving}>
    <form className="stack" onSubmit={save}>
      <TextInput label="표시 이름" data-autofocus value={draft} onChange={(event) => setDraft(event.currentTarget.value)}
        description="최대 40자. 비우면 이메일 아이디가 표시됩니다." />
      {error && <InlineError message={error} />}
      <Button type="submit" loading={saving}>저장</Button>
    </form>
  </AppModal>;
}
