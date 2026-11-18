"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { createPlaybackClock } from "../lib/playback-clock";
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

export function ReviewWaveform({ audio, duration, peaks, position, range, setRange, seek, notes, selected, previewEnd, openNote }: {
  audio: RefObject<HTMLAudioElement | null>;
  duration: number;
  peaks: number[];
  position: number;
  range?: [number, number];
  setRange: (range: [number, number]) => void;
  seek: (position: number) => void;
  notes?: Note[];
  selected?: Note;
  previewEnd: RefObject<number | null>;
  openNote: (note: Note) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const playedWaveform = useRef<HTMLCanvasElement>(null);
  const playhead = useRef<HTMLSpanElement>(null);
  const waveformGesture = useRef<WaveformGesture | null>(null);
  const [openMarker, setOpenMarker] = useState<string>();
  const selectedStart = selected?.start_ms;
  const selectedEnd = selected?.end_ms;
  const markers = duration ? groupMarkers(notes ?? [], duration) : [];

  useEffect(() => {
    const target = canvas.current;
    const context = target?.getContext("2d");
    const playedContext = playedWaveform.current?.getContext("2d");
    if (!target || !context || !playedContext) return;

    const { width, height } = target;
    const waveform = new Path2D();
    const barWidth = width / (peaks.length || 1);
    for (const [index, value] of peaks.entries()) {
      const barHeight = Math.max(2, Math.min(1, value) * height);
      waveform.rect(index * barWidth, (height - barHeight) / 2, Math.max(1, barWidth - 1), barHeight);
    }

    context.clearRect(0, 0, width, height);
    playedContext.clearRect(0, 0, width, height);
    if (selectedStart !== undefined && duration) {
      context.fillStyle = "#bddde9";
      const x = Math.min(width - 2, selectedStart / duration * width);
      context.fillRect(x, 0, Math.max(2, ((selectedEnd ?? selectedStart) - selectedStart) / duration * width), height);
    }
    if (range && range[1] > range[0] && duration) {
      context.fillStyle = "#d7ecdc";
      context.fillRect(range[0] / duration * width, 0, (range[1] - range[0]) / duration * width, height);
    }

    context.fillStyle = "#8b99a6";
    context.fill(waveform);
    playedContext.fillStyle = "#1a7138";
    playedContext.fill(waveform);
  }, [duration, peaks, range, selectedStart, selectedEnd]);

  useEffect(() => {
    const target = canvas.current;
    const played = playedWaveform.current;
    const head = playhead.current;
    const player = audio.current;
    if (!target || !played || !head || !player || !duration) return;

    const clock = createPlaybackClock();
    let frame = 0;
    let width = target.clientWidth;

    const paint = (seconds: number) => {
      const progress = Math.min(1, Math.max(0, seconds * 1000 / duration));
      played.style.clipPath = `inset(0 ${(1 - progress) * 100}% 0 0)`;
      head.style.transform = `translate3d(${Math.min(progress * width, Math.max(0, width - 2))}px, 0, 0)`;
    };

    const draw = (timestamp: number) => {
      if (previewEnd.current !== null && player.currentTime * 1000 >= previewEnd.current) {
        const end = previewEnd.current;
        previewEnd.current = null;
        player.pause();
        player.currentTime = end / 1000;
        paint(end / 1000);
        return;
      }

      paint(clock.read({ seconds: player.currentTime, timestamp, playbackRate: player.playbackRate }));
      frame = requestAnimationFrame(draw);
    };

    const stop = () => {
      cancelAnimationFrame(frame);
      paint(clock.reset({ seconds: player.currentTime, timestamp: performance.now() }));
    };
    const synchronize = () => {
      stop();
      if (!player.paused && !player.ended && !player.seeking && player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        frame = requestAnimationFrame(draw);
      }
    };
    const stops = ["pause", "ended", "waiting", "emptied", "seeking"];
    const starts = ["loadedmetadata", "playing", "seeked", "ratechange"];
    for (const event of stops) player.addEventListener(event, stop);
    for (const event of starts) player.addEventListener(event, synchronize);

    const resize = new ResizeObserver(() => {
      width = target.clientWidth;
      if (player.paused) paint(player.currentTime);
    });
    resize.observe(target);
    synchronize();

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      for (const event of stops) player.removeEventListener(event, stop);
      for (const event of starts) player.removeEventListener(event, synchronize);
    };
  }, [audio, duration, previewEnd]);

  function clamp(ms: number) {
    return Math.round(Math.min(duration, Math.max(0, ms)));
  }

  function pointerPosition(event: PointerEvent<HTMLElement>) {
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds?.width) return 0;
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

  function moveRangeEdge(index: 0 | 1, value: number) {
    if (!range) return;
    const point = clamp(value);
    setRange(index === 0 ? [Math.min(point, range[1]), range[1]] : [range[0], Math.max(point, range[0])]);
  }

  const markerGroup = !range ? markers.find((group) => group[0].id === openMarker) : undefined;

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
        <canvas ref={playedWaveform} width={1024} height={180} className="waveform waveform-played" aria-hidden="true" />
        <span ref={playhead} className="waveform-playhead" aria-hidden="true" />
        {range && ([0, 1] as const).map((index) => {
          const label = index === 0 ? "구간 시작" : "구간 끝";
          return <button key={index} type="button" className="range-handle" role="slider"
            style={{ left: `clamp(12px, ${range[index] / duration * 100}%, calc(100% - 12px))` }}
            aria-label={label} aria-valuemin={0} aria-valuemax={duration}
            aria-valuenow={range[index]} aria-valuetext={timecode(range[index])}
            onKeyDown={(event) => {
              const step = Math.min(1000, Math.max(1, Math.round(duration / 100)));
              const target = { ArrowLeft: range[index] - step, ArrowDown: range[index] - step,
                ArrowRight: range[index] + step, ArrowUp: range[index] + step, Home: 0, End: duration }[event.key];
              if (target === undefined) return;
              event.preventDefault();
              moveRangeEdge(index, target);
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) moveRangeEdge(index, pointerPosition(event));
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) moveRangeEdge(index, pointerPosition(event));
            }} />
        })}
        {!range && markers.map((group) => {
          const first = group[0];
          const active = group.some(({ id }) => id === selected?.id);
          return <button type="button" className="wave-marker" key={first.id}
            style={{ left: `clamp(22px, ${first.start_ms / duration * 100}%, calc(100% - 22px))` }}
            aria-label={noteLabel(first) + " 피드백 " + group.length + "개"} aria-current={active || undefined}
            aria-expanded={group.length > 1 ? openMarker === first.id : undefined} onClick={() => {
              if (group.length === 1) {
                setOpenMarker(undefined);
                openNote(first);
              } else {
                setOpenMarker(openMarker === first.id ? undefined : first.id);
              }
            }}>{group.length}</button>;
        })}
      </div>
      <div className="row spread waveform-ticks" aria-hidden="true">
        {[0, .25, .5, .75, 1].map((part) => <span key={part}>{duration < 4000 ? (duration * part / 1000).toFixed(1) + "초" : timecode(duration * part).split(".")[0]}</span>)}
      </div>
      {markerGroup && <div className="marker-choices" aria-label="겹친 피드백">
        {markerGroup.map((note) => <button type="button" key={note.id} onClick={() => {
          setOpenMarker(undefined);
          openNote(note);
        }}><strong className="feedback-time">{noteLabel(note)}</strong> {note.body}</button>)}
      </div>}
  </>;
}
