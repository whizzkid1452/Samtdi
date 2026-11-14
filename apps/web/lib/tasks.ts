export type TaskStatus = "todo" | "progress" | "review" | "done";

export const statuses: [TaskStatus, string][] = [
  ["todo", "할 일"], ["progress", "진행 중"], ["review", "검토 요청"], ["done", "완료"],
];

export function statusLabel(status: string) {
  return statuses.find(([value]) => value === status)?.[1] ?? status;
}

/** Today's calendar date in Seoul as YYYY-MM-DD, matching how due dates are stored and judged late. */
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

export type DueTone = "late" | "today" | "soon" | "later" | "done";

export function dueState(due: string, status?: string, today = todayInSeoul()): { tone: DueTone; label: string } {
  const days = daysBetween(today, due);
  const date = shortDate(due);
  if (status === "done") return { tone: "done", label: date };
  if (days < 0) return { tone: "late", label: date + " · " + -days + "일 지연" };
  if (days === 0) return { tone: "today", label: "오늘 마감" };
  if (days <= 7) return { tone: "soon", label: date + " · D-" + days };
  return { tone: "later", label: date };
}
