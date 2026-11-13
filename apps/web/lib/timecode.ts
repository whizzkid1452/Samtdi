export function timecode(ms: number) {
  const value = Math.round(ms);
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${String(value % 1000).padStart(3, "0")}`;
}
