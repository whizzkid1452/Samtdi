"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import { createPlaybackClock } from "../lib/playback-clock";
import { timecode } from "../lib/timecode";
import { useReviewRegions } from "./use-review-regions";
import { noteLabel, type Note } from "./version-notes";

type WaveformGesture = { pointerId: number; rangeStart?: number };
type WaveformInstance = { peaks: number[]; regions: ReturnType<typeof RegionsPlugin.create> };

function groupMarkers(notes: Note[], duration: number) {
  const groups: Note[][] = [];
  for (const note of [...notes].filter(({ deleted }) => !deleted).sort((left, right) => left.start_ms - right.start_ms)) {
    const group = groups.at(-1);
    if (group && note.start_ms - group[0].start_ms < duration * 0.025) group.push(note);
    else groups.push([note]);
  }
  return groups;
}

export function ReviewWaveform({ audio, duration, peaks, position, range, setRange, seek, notes, selected, previewEnd, openNote, onError, togglePlayback }: {
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
  onError: (message: string) => void;
  togglePlayback: () => void;
}) {
  const waveform = useRef<HTMLDivElement>(null);
  const seekSlider = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLSpanElement>(null);
  const gesture = useRef<WaveformGesture | null>(null);
  const [instance, setInstance] = useState<WaveformInstance>();
  const [openMarker, setOpenMarker] = useState<string>();
  const regions = instance?.peaks === peaks ? instance.regions : undefined;
  const markers = duration ? groupMarkers(notes ?? [], duration) : [];

  useEffect(() => {
    const target = waveform.current;
    const player = audio.current;
    if (!target || !player || !duration || !peaks.length) return;

    const regions = RegionsPlugin.create();
    const wavesurfer = WaveSurfer.create({
      container: target,
      media: player,
      peaks: [peaks],
      duration: duration / 1000,
      height: "auto",
      waveColor: "#8b99a6",
      progressColor: "#1a7138",
      cursorWidth: 0,
      interact: false,
      plugins: [regions],
    });
    const ready = wavesurfer.on("ready", () => setInstance({ peaks, regions }));
    const error = wavesurfer.on("error", () => {
      if (!player.error) onError("파형을 표시하지 못했습니다.");
    });
    return () => {
      ready();
      error();
      wavesurfer.destroy();
    };
  }, [audio, duration, peaks, onError]);

  useReviewRegions({ regions, duration, range, setRange, selected });

  useEffect(() => {
    const target = waveform.current;
    const head = playhead.current;
    const player = audio.current;
    if (!target || !head || !player || !duration) return;

    const clock = createPlaybackClock();
    let frame = 0;
    let width = target.clientWidth;
    const headWidth = head.offsetWidth;

    const paint = (seconds: number) => {
      const progress = Math.min(1, Math.max(0, seconds * 1000 / duration));
      target.style.setProperty("--review-progress", `${progress * 100}%`);
      head.style.transform = `translate3d(${Math.min(progress * width, Math.max(0, width - headWidth))}px, 0, 0)`;
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

  function pointerTime(event: PointerEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    const offset = event.clientX - target.getBoundingClientRect().left - target.clientLeft;
    const progress = target.clientWidth ? offset / target.clientWidth : 0;
    return Math.round(Math.min(1, Math.max(0, progress)) * duration);
  }

  function updateGesture(event: PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (active?.pointerId !== event.pointerId) return;

    const at = pointerTime(event);
    if (active.rangeStart === undefined) seek(at);
    else setRange([Math.min(active.rangeStart, at), Math.max(active.rangeStart, at)]);
  }

  function seekWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!duration) return;
    if (event.key === " ") {
      event.preventDefault();
      togglePlayback();
      return;
    }

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

  const markerGroup = !range ? markers.find((group) => group[0].id === openMarker) : undefined;

  return <>
      <div className="waveform-frame">
        <div ref={waveform} className={"waveform" + (range ? " selecting" : "")}
          onPointerDown={(event) => {
            if (!duration || !event.isPrimary || event.button !== 0) return;

            gesture.current = { pointerId: event.pointerId, rangeStart: range ? pointerTime(event) : undefined };
            seekSlider.current?.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            updateGesture(event);
          }}
          onPointerMove={updateGesture}
          onPointerUp={updateGesture}
          onLostPointerCapture={(event) => {
            if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
          }} />
        <div ref={seekSlider} className="waveform-seek-slider" role="slider"
          tabIndex={duration ? 0 : -1} aria-label="재생 위치" aria-disabled={!duration}
          aria-valuemin={0} aria-valuemax={duration} aria-valuenow={position} aria-valuetext={timecode(position)}
          onKeyDown={seekWithKeyboard} />
        <span ref={playhead} className="waveform-playhead" aria-hidden="true" />
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
