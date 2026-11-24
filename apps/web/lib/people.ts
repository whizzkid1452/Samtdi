export type PersonLike = { name?: string; email?: string };

/** The chosen display name, or the part of the email before `@` when no name is set. */
export function displayName({ name, email }: PersonLike) {
  return name?.trim() || email?.split("@")[0] || "알 수 없음";
}

const hangul = /^[가-힣]+$/;

/** Short avatar text: the given name for Korean full names (김민준 → 민준), otherwise up to two initials. */
export function initials(person: PersonLike) {
  const label = displayName(person);
  if (hangul.test(label)) return label.length >= 3 ? label.slice(-2) : label;

  const words = label.split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : label.slice(0, 2)).toUpperCase();
}

/** A stable palette slot (0-7) for an account, so the same person keeps the same avatar color everywhere. */
export function avatarTone(id: string) {
  let hash = 0x811c9dc5;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  return hash % 8;
}
