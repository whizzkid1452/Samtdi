"use client";

import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { timecode } from "../lib/timecode";
import { noteLabel, type Note } from "./version-notes";

type WaveformGesture = { pointerId: number; rangeStart?: number };

function groupMarkers(notes: Note[], duration: number) {
  const groups: Note[][] = [];
  for (const note of [...notes].filter(({ deleted }) => !deleted).sort((left, right) => left.start_ms - right.start_ms)) {
    const group = groups.at(-1);
    if (group && note.start_ms - group[0].start_ms < duration * 0.025) group.push(note);
    else groups.push([note]);
  }
  return groups;
}

export function ReviewWaveform({ audio, duration, peaks, position, range, setRange, seek, notes, selectedId, openNote }: {
  audio: RefObject<HTMLAudioElement | null>;
  duration: number;
  peaks: number[];
  position: number;
  range?: [number, number];
  setRange: (range: [number, number]) => void;
  seek: (position: number) => void;
  notes?: Note[];
  selectedId?: string;
  openNote: (note: Note) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const waveformGesture = useRef<WaveformGesture | null>(null);
  const markers = duration ? groupMarkers(notes ?? [], duration) : [];

  useEffect(() => {
    const target = canvas.current;
    const player = audio.current;
    const context = target?.getContext("2d");
    if (!target || !player || !context || !duration) return;

    const { width, height } = target;
    const waveform = new Path2D();
    const barWidth = width / (peaks.length || 1);
    for (const [index, value] of peaks.entries()) {
      const barHeight = Math.max(2, Math.min(1, value) * height);
      waveform.rect(index * barWidth, (height - barHeight) / 2, Math.max(1, barWidth - 1), barHeight);
    }

    let frame = 0;
    const draw = () => {
      const progress = Math.min(1, player.currentTime * 1000 / duration);
      const playheadX = progress * width;
      context.clearRect(0, 0, width, height);
      if (range && range[1] > range[0]) {
        context.fillStyle = "#d7ecdc";
        context.fillRect(range[0] / duration * width, 0, (range[1] - range[0]) / duration * width, height);
      }

      context.fillStyle = "#8b99a6";
      context.fill(waveform);
      if (playheadX > 0) {
        context.save();
        context.beginPath();
        context.rect(0, 0, playheadX, height);
        context.clip();
        context.fillStyle = "#1a7138";
        context.fill(waveform);
        context.restore();
      }

      context.fillStyle = "#1f2328";
      context.fillRect(Math.min(playheadX, width - 2), 0, 2, height);
      if (!player.paused && !player.ended) frame = requestAnimationFrame(draw);
    };

    const refresh = () => {
      cancelAnimationFrame(frame);
      draw();
    };
    const events = ["loadedmetadata", "play", "pause", "ended", "seeking", "seeked"];
    for (const event of events) player.addEventListener(event, refresh);
    refresh();

    return () => {
      cancelAnimationFrame(frame);
      for (const event of events) player.removeEventListener(event, refresh);
    };
  }, [audio, duration, peaks, range]);

  function clamp(ms: number) {
    return Math.round(Math.min(duration, Math.max(0, ms)));
  }

  function pointerPosition(event: PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return clamp((event.clientX - bounds.left) / bounds.width * duration);
  }

  function moveWaveformPointer(event: PointerEvent<HTMLCanvasElement>) {
    const gesture = waveformGesture.current;
    if (gesture?.pointerId !== event.pointerId) return;

    const point = pointerPosition(event);
    if (gesture.rangeStart === undefined) seek(point);
    else setRange([Math.min(point, gesture.rangeStart), Math.max(point, gesture.rangeStart)]);
  }

  function endWaveformGesture(event: PointerEvent<HTMLCanvasElement>) {
    if (waveformGesture.current?.pointerId === event.pointerId) waveformGesture.current = null;
  }

  function seekWithKeyboard(event: KeyboardEvent<HTMLCanvasElement>) {
    if (!duration) return;

    const current = (audio.current?.currentTime ?? 0) * 1000;
    const step = Math.min(1000, duration / 100);
    const targets: Record<string, number> = {
      ArrowLeft: current - step,
      ArrowDown: current - step,
      ArrowRight: current + step,
      ArrowUp: current + step,
      PageDown: current - duration / 10,
      PageUp: current + duration / 10,
      Home: 0,
      End: duration,
    };
    const target = targets[event.key];
    if (!Number.isFinite(target)) return;

    event.preventDefault();
    seek(target);
  }

  return <>
      <div className="waveform-frame">
        <canvas ref={canvas} width={1024} height={180} className={"waveform" + (range ? " selecting" : "")}
          role="slider" tabIndex={duration ? 0 : -1} aria-label="재생 위치" aria-disabled={!duration}
          aria-valuemin={0} aria-valuemax={duration} aria-valuenow={position} aria-valuetext={timecode(position)}
          onKeyDown={seekWithKeyboard}
          onPointerDown={(event) => {
            if (!duration || !event.isPrimary || event.button !== 0) return;

            const point = pointerPosition(event);
            waveformGesture.current = { pointerId: event.pointerId, rangeStart: range ? point : undefined };
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            moveWaveformPointer(event);
          }}
          onPointerMove={moveWaveformPointer}
          onPointerUp={(event) => {
            moveWaveformPointer(event);
            endWaveformGesture(event);
          }}
          onPointerCancel={endWaveformGesture}
          onLostPointerCapture={endWaveformGesture} />
        {!range && markers.map((group) => {
          const first = group[0];
          return <button type="button" className="wave-marker" key={first.id}
            style={{ left: `clamp(16px, ${first.start_ms / duration * 100}%, calc(100% - 16px))` }}
            aria-label={noteLabel(first) + " 피드백 " + group.length + "개"} onClick={() => {
              const index = group.findIndex(({ id }) => id === selectedId);
              const note = group[(index + 1) % group.length];
              openNote(note);
            }}>{group.length}</button>;
        })}
      </div>
      <div className="row spread waveform-ticks" aria-hidden="true">
        {[0, .25, .5, .75, 1].map((part) => <span key={part}>{duration < 4000 ? (duration * part / 1000).toFixed(1) + "초" : timecode(duration * part).split(".")[0]}</span>)}
      </div>
  </>;
}
