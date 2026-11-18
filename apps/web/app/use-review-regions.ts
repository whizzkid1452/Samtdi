import { useEffect } from "react";
import type RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import type { Region } from "wavesurfer.js/dist/plugins/regions.js";
import { timecode } from "../lib/timecode";
import type { Note } from "./version-notes";

const DRAFT_REGION = "review-draft";
const FEEDBACK_REGION = "review-feedback";

type Range = [startMs: number, endMs: number];
type SetRange = (range: Range) => void;

function toRange(region: Region, duration: number): Range {
  return [
    Math.min(duration, Math.round(region.start * 1000)),
    Math.min(duration, Math.round(region.end * 1000)),
  ];
}

function syncHandles(region: Region, duration: number, setRange: SetRange) {
  const values = toRange(region, duration);
  for (const [index, side, label] of [[0, "left", "구간 시작"], [1, "right", "구간 끝"]] as const) {
    const handle = region.element?.querySelector<HTMLElement>(`[part~="region-handle-${side}"]`);
    if (!handle) continue;

    const value = values[index];
    // The plugin handles resize drags. Do not start a new selection on the waveform beneath the handle.
    handle.onpointerdown = (event) => event.stopPropagation();
    handle.tabIndex = 0;
    handle.setAttribute("role", "slider");
    handle.setAttribute("aria-label", label);
    handle.setAttribute("aria-valuemin", String(index === 0 ? 0 : values[0]));
    handle.setAttribute("aria-valuemax", String(index === 0 ? values[1] : duration));
    handle.setAttribute("aria-valuenow", String(value));
    handle.setAttribute("aria-valuetext", timecode(value));
    handle.onkeydown = (event) => {
      const step = Math.min(1000, Math.max(1, Math.round(duration / 100)));
      const targets: Record<string, number> = {
        ArrowLeft: value - step, ArrowDown: value - step, ArrowRight: value + step, ArrowUp: value + step,
        Home: 0, End: duration,
      };
      const next = targets[event.key];
      if (next === undefined) return;

      event.preventDefault();
      event.stopPropagation();
      setRange(index === 0
        ? [Math.max(0, Math.min(next, values[1])), values[1]]
        : [values[0], Math.min(duration, Math.max(next, values[0]))]);
    };
  }
}

export function useReviewRegions({ regions, duration, range, setRange, selected }: {
  regions?: ReturnType<typeof RegionsPlugin.create>;
  duration: number;
  range?: Range;
  setRange: SetRange;
  selected?: Note;
}) {
  const [start, end] = range ?? [];
  const selectedStart = selected?.start_ms;
  const selectedEnd = selected?.end_ms;

  useEffect(() => {
    if (!regions) return;

    return regions.on("region-updated", (region) => {
      if (region.id === DRAFT_REGION) setRange(toRange(region, duration));
    });
  }, [regions, duration, setRange]);

  useEffect(() => {
    if (!regions) return;

    const region = regions.getRegions().find(({ id }) => id === DRAFT_REGION);
    if (start === undefined || end === undefined) {
      region?.remove();
      return;
    }

    const boundaries = { start: start / 1000, end: Math.max(start, end) / 1000 };
    if (region && (region.start !== boundaries.start || region.end !== boundaries.end)) {
      region.setOptions(boundaries);
    }

    const draft = region ?? regions.addRegion({
      id: DRAFT_REGION,
      ...boundaries,
      color: "rgba(41, 134, 72, .18)",
      drag: false,
    });
    syncHandles(draft, duration, setRange);
  }, [regions, start, end, duration, setRange]);

  useEffect(() => {
    if (!regions || selectedStart === undefined) return;

    const highlight = regions.addRegion({
      id: FEEDBACK_REGION,
      start: selectedStart / 1000,
      end: (selectedEnd ?? selectedStart) / 1000,
      color: "rgba(54, 139, 185, .24)",
      drag: false,
      resize: false,
    });
    return () => highlight.remove();
  }, [regions, selectedStart, selectedEnd]);
}
