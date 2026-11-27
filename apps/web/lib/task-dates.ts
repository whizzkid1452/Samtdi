export function todayInSeoul() {
  return new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeZone: "Asia/Seoul" }).format(new Date());
}

export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export function addDays(date: string, days: number) {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 2026-11-20 → 11월 20일 */
export function shortDate(date: string) {
  const [, month, day] = date.split("-");
  return Number(month) + "월 " + Number(day) + "일";
}
