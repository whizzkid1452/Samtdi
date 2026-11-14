"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { avatarTone, displayName, initials, type PersonLike } from "../lib/people";
import { dueState, statusLabel } from "../lib/tasks";

const paths = {
  bell: <><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  chevron: <path d="M6 9l6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  more: <><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  music: <><path d="M9 17.5V5.5l10.5-2v12" /><circle cx="6.5" cy="17.5" r="2.5" /><circle cx="17" cy="15.5" r="2.5" /></>,
  message: <path d="M4.5 5h15v10.5H10l-5.5 4z" />,
  list: <path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  board: <><rect x="3.5" y="4" width="4.5" height="16" rx="1.2" /><rect x="9.75" y="4" width="4.5" height="10" rx="1.2" /><rect x="16" y="4" width="4.5" height="13" rx="1.2" /></>,
  timeline: <path d="M3.5 6.5h9M7.5 12h12M5.5 17.5h8" />,
  play: <path d="M8 5.5l11 6.5-11 6.5z" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  users: <><circle cx="9" cy="8.5" r="3.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5a3.5 3.5 0 0 1 0 7M21 20c0-2.6-1.6-4.8-3.8-5.6" /></>,
  swap: <path d="M7 4v16M3.5 7.5L7 4l3.5 3.5M17 20V4M13.5 16.5L17 20l3.5-3.5" />,
  up: <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />,
  down: <path d="M12 5v14M5.5 12.5L12 19l6.5-6.5" />,
  alert: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5.5M12 16.5h.01" /></>,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  logout: <path d="M14 4.5h4.5v15H14M10 8l-4 4 4 4M6 12h10" />,
  folder: <path d="M3.5 6.5h6l2 2h9v10h-17z" />,
  inbox: <path d="M3.5 13.5l2.5-8h12l2.5 8v5h-17zM3.5 13.5H8.5l1 2h5l1-2h5" />,
} as const;

export type IconName = keyof typeof paths;
const filled: IconName[] = ["more", "play"];

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const solid = filled.includes(name);
  return <svg className="icon" aria-hidden="true" viewBox="0 0 24 24" width={size} height={size}
    fill={solid ? "currentColor" : "none"} stroke={solid ? "none" : "currentColor"} strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function Avatar({ id, person, size = "md", labelled = false }: {
  id: string; person: PersonLike; size?: "sm" | "md" | "lg"; labelled?: boolean;
}) {
  const label = displayName(person);
  return <span className={"avatar avatar-" + size + " tone-" + avatarTone(id || label)} title={label}
    role={labelled ? "img" : undefined} aria-label={labelled ? label : undefined} aria-hidden={labelled ? undefined : true}>
    {initials(person)}
  </span>;
}

/** Avatar and name together; the name stays as text so it is read and searchable. */
export function Person({ id, person, size = "sm", detail }: { id: string; person: PersonLike; size?: "sm" | "md"; detail?: ReactNode }) {
  return <span className="person">
    <Avatar id={id} person={person} size={size} />
    <span className="person-text"><span className="person-name">{displayName(person)}</span>{detail}</span>
  </span>;
}

export function Unassigned() {
  return <span className="person person-empty"><span className="avatar avatar-sm avatar-empty" aria-hidden="true" />
    <span className="person-name">미할당</span></span>;
}

export function MemberStack({ members, limit = 5 }: { members: { account_id: string; email: string; name?: string }[]; limit?: number }) {
  const shown = members.slice(0, limit);
  return <span className="member-stack" role="img" aria-label={"팀원 " + members.length + "명: " + members.map(displayName).join(", ")}>
    {shown.map((member) => <Avatar key={member.account_id} id={member.account_id} person={member} size="sm" />)}
    {members.length > limit && <span className="avatar avatar-sm avatar-more" aria-hidden="true">+{members.length - limit}</span>}
  </span>;
}

export function StatusChip({ status, suffix }: { status: string; suffix?: string }) {
  return <span className={"status-chip status-" + status}><span className="status-dot" aria-hidden="true" />{statusLabel(status)}{suffix}</span>;
}

export function DueChip({ due, status, empty }: { due?: string; status?: string; empty?: string }) {
  if (!due) return empty ? <span className="due-chip due-none">{empty}</span> : null;
  const { tone, label } = dueState(due, status);
  return <span className={"due-chip due-" + tone} title={"마감일 " + due}><Icon name={tone === "late" ? "alert" : "calendar"} size={14} />{label}</span>;
}

export function CountBadge({ value, label }: { value: number; label?: string }) {
  return <span className="count-badge" aria-label={label}>{value > 99 ? "99+" : value}</span>;
}

/**
 * A button that opens a small popover. Closes on outside pointer, Escape (returning focus to the button) or `close()`.
 */
export function Menu({ label, buttonLabel, children, align = "end", className = "", buttonClassName = "", onOpenChange }: {
  label: ReactNode; buttonLabel?: string; children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end"; className?: string; buttonClassName?: string; onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popover = useId();

  function change(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
  }

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(false);
        onOpenChange?.(false);
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      onOpenChange?.(false);
      button.current?.focus();
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [onOpenChange, open]);

  const close = () => change(false);
  return <div ref={root} className={"menu " + className}>
    <button ref={button} type="button" className={"menu-button " + buttonClassName} aria-expanded={open} aria-controls={open ? popover : undefined}
      aria-label={buttonLabel} onClick={() => change(!open)}>{label}</button>
    {open && <div id={popover} className={"menu-popover menu-" + align}>{typeof children === "function" ? children(close) : children}</div>}
  </div>;
}
