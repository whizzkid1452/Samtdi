import assert from "node:assert/strict";
import test from "node:test";
import { createPlaybackClock } from "./playback-clock.ts";

test("does not advance before the media clock starts", () => {
  const clock = createPlaybackClock();
  clock.reset({ seconds: 0, timestamp: 0 });
  assert.equal(clock.read({ seconds: 0, timestamp: 200, playbackRate: 1 }), 0);
});

test("advances each frame between coarse media samples without moving backwards", () => {
  const clock = createPlaybackClock();
  clock.reset({ seconds: 0, timestamp: 0 });
  const positions = Array.from({ length: 60 }, (_, index) => {
    const timestamp = (index + 1) * 1000 / 60;
    return clock.read({ seconds: Math.floor(timestamp / 100) / 10, timestamp, playbackRate: 1 });
  });
  for (let index = 7; index < positions.length; index++) {
    assert.ok(Math.abs(positions[index] - positions[index - 1] - 1 / 60) < 1e-8);
  }
});

test("resets immediately for pause, buffering, forward/backward seek, and replay", () => {
  const clock = createPlaybackClock();
  clock.reset({ seconds: 12, timestamp: 0 });
  clock.read({ seconds: 12.1, timestamp: 100, playbackRate: 1 });
  assert.equal(clock.reset({ seconds: 12.08, timestamp: 110 }), 12.08);
  assert.equal(clock.read({ seconds: 12.08, timestamp: 210, playbackRate: 1 }), 12.08);
  assert.equal(clock.reset({ seconds: 30, timestamp: 220 }), 30);
  assert.equal(clock.reset({ seconds: 2, timestamp: 230 }), 2);
  assert.equal(clock.read({ seconds: 2, timestamp: 330, playbackRate: 1 }), 2);
  assert.equal(clock.reset({ seconds: 0, timestamp: 340 }), 0);
});

test("uses playback rate and elapsed time after a skipped animation frame", () => {
  const clock = createPlaybackClock();
  clock.reset({ seconds: 1, timestamp: 0 });
  clock.read({ seconds: 1.02, timestamp: 10, playbackRate: 2 });
  assert.ok(Math.abs(clock.read({ seconds: 1.02, timestamp: 110, playbackRate: 2 }) - 1.22) < 1e-8);
  assert.ok(Math.abs(clock.read({ seconds: 3.02, timestamp: 1110, playbackRate: 2 }) - 3.22) < 1e-8);
});
