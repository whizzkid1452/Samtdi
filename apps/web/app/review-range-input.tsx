"use client";

import { useState } from "react";

export function ReviewRangeInput({ label, value, duration, change }: {
  label: string;
  value: number;
  duration: number;
  change: (milliseconds: number) => void;
}) {
  const [input, setInput] = useState<string>();

  return <label>{label} (초)
    <input type="number" min={0} max={duration / 1000} step={.001} value={input ?? value / 1000}
      onChange={(event) => {
        const text = event.target.value;
        setInput(text);
        if (text !== "") change(Number(text) * 1000);
      }}
      onBlur={() => setInput(undefined)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }} />
  </label>;
}
