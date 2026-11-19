"use client";

import { Button, Combobox, useCombobox } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../lib/api";
import type { components } from "../lib/api-types";
import { timecode } from "../lib/timecode";
import { InlineError } from "./request-states";

type Options = components["schemas"]["TaskOptions"];
type Note = components["schemas"]["TaskNote"];
type Version = components["schemas"]["TaskVersion"];
type PickerProps =
  | { base: string; kind: "note"; select: (note: Note) => void; selectedIds: string[] }
  | { base: string; kind: "version"; select: (version: Version) => void };

const pageSize = 100;

export function TaskOptionPicker(props: PickerProps) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Options>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const nextPage = useRef<AbortController | null>(null);
  const picker = useCombobox({
    onDropdownOpen: () => picker.focusSearchInput(),
    onDropdownClose: () => picker.resetSelectedOption(),
  });
  const { dropdownOpened } = picker;
  const { kind } = props;
  const path = props.base + "/task-options?" + new URLSearchParams({ kind: props.kind, q: query });
  const rows = props.kind === "note" ? options?.notes : options?.versions;

  useEffect(() => {
    if (!dropdownOpened) return;

    const request = new AbortController();
    api<Options>(path, { signal: request.signal }).then((result) => {
      if (!request.signal.aborted) {
        setOptions(result);
        setHasMore((kind === "note" ? result.notes : result.versions).length === pageSize);
        setError("");
      }
    }).catch((cause) => { if (!request.signal.aborted) setError(describeError(cause)); });

    return () => {
      request.abort();
      nextPage.current?.abort();
    };
  }, [attempt, dropdownOpened, kind, path]);

  async function more() {
    const cursor = rows?.at(-1)?.id;
    if (!cursor || nextPage.current) return;

    const request = new AbortController();
    nextPage.current = request;
    setLoadingMore(true);
    try {
      const next = await api<Options>(path + "&" + new URLSearchParams({ before: cursor }), { signal: request.signal });
      if (request.signal.aborted) return;

      setHasMore((kind === "note" ? next.notes : next.versions).length === pageSize);
      setOptions((previous) => previous && {
        notes: [...previous.notes, ...next.notes.filter((note) => !previous.notes.some(({ id }) => id === note.id))],
        versions: [...previous.versions, ...next.versions.filter((version) => !previous.versions.some(({ id }) => id === version.id))],
      });
    } catch (cause) {
      if (!request.signal.aborted) setError(describeError(cause));
    } finally {
      nextPage.current = null;
      setLoadingMore(false);
    }
  }

  function search() {
    if (input.trim() === query && !error) return;

    picker.resetSelectedOption();
    nextPage.current?.abort();
    setOptions(undefined);
    setError("");
    if (input.trim() === query) setAttempt((value) => value + 1);
    else setQuery(input.trim());
  }

  const label = props.kind === "note" ? "피드백 연결" : "결과 버전 선택";
  const searchLabel = props.kind === "note" ? "피드백 검색" : "버전 검색";

  return (
    <Combobox store={picker} withinPortal={false} onOptionSubmit={(id) => {
      if (props.kind === "note") {
        const note = options?.notes.find((option) => option.id === id);
        if (note) props.select(note);
      } else {
        const version = options?.versions.find((option) => option.id === id);
        if (version) props.select(version);
      }

      picker.closeDropdown();
      picker.focusTarget();
    }}>
      <Combobox.Target targetType="button">
        <Button type="button" justify="space-between" variant="default" rightSection={<Combobox.Chevron />}
          onClick={() => picker.toggleDropdown()}>{label}</Button>
      </Combobox.Target>
      <Combobox.Dropdown>
        <div className="row option-search">
          <Combobox.Search aria-label={searchLabel} placeholder={searchLabel} maxLength={200} value={input}
            onChange={(event) => { setInput(event.currentTarget.value); picker.resetSelectedOption(); }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (event.nativeEvent.isComposing) { event.preventDefault(); return; }
              if (picker.getSelectedOptionIndex() >= 0) return;

              event.preventDefault();
              search();
            }} />
          <Button type="button" variant="default" size="compact-sm" onClick={search}>검색</Button>
        </div>
        {error && <InlineError message={error} />}
        {!rows && !error && <p role="status">불러오는 중</p>}
        <Combobox.Options className="task-option-list">
          {rows?.length === 0 && <Combobox.Empty>일치하는 항목이 없습니다.</Combobox.Empty>}
          {props.kind === "note" && options?.notes.map((note) => (
            <Combobox.Option key={note.id} value={note.id} disabled={note.deleted || props.selectedIds.includes(note.id)}>
              {timecode(note.start_ms)} · {note.deleted ? "삭제된 피드백" : note.body}
            </Combobox.Option>
          ))}
          {props.kind === "version" && options?.versions.map((version) => (
            <Combobox.Option key={version.id} value={version.id}>{version.filename}</Combobox.Option>
          ))}
        </Combobox.Options>
        {rows && hasMore && (
          <Button type="button" variant="default" size="compact-sm" loading={loadingMore} onClick={() => void more()}>더 보기</Button>
        )}
      </Combobox.Dropdown>
    </Combobox>
  );
}
