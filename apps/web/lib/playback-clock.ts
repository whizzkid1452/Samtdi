type PlaybackSample = { seconds: number; timestamp: number };

export function createPlaybackClock() {
  let previous: PlaybackSample & { displayed: number; advancing: boolean } | undefined;

  function reset({ seconds, timestamp }: PlaybackSample) {
    previous = { seconds, timestamp, displayed: seconds, advancing: false };
    return seconds;
  }

  function read({ seconds, timestamp, playbackRate }: PlaybackSample & { playbackRate: number }) {
    if (!previous) return reset({ seconds, timestamp });

    // Media time can repeat between display frames. Project only the visual position;
    // playback/seek/buffering events reset it to the authoritative media position.
    const advancing = previous.advancing || seconds > previous.seconds;
    const elapsed = Math.max(0, timestamp - previous.timestamp) / 1000;
    const displayed = advancing ? Math.max(seconds, previous.displayed + elapsed * playbackRate) : seconds;
    previous = { seconds, timestamp, displayed, advancing };
    return displayed;
  }

  return { reset, read };
}
