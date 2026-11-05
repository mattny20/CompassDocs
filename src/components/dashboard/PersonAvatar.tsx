// A directory person's face on the dashboard (1.17.0: My team, People this
// week): their photo when the directory has one, else their initials on a
// soft tint picked by id, so the same person keeps the same colour on every
// visit. Decorative — the name is always written beside it, or (a bare
// avatar in a row) carried by the link around it. Server-safe.

import { initialsOf } from "@/lib/directory-display";

// Tints, not chips: light ink-on-pastel in the light theme, a translucent
// wash with light ink in the dark one (plain Tailwind hues do not flip).
const TINTS = [
  "bg-sky-100 text-sky-800 dark:bg-sky-400/20 dark:text-sky-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/20 dark:text-emerald-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-400/20 dark:text-amber-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-400/20 dark:text-violet-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-400/20 dark:text-rose-200",
  "bg-teal-100 text-teal-800 dark:bg-teal-400/20 dark:text-teal-200",
];

export function PersonAvatar({
  person,
  size = "md",
}: {
  person: { id: number; name: string; photo: string };
  /** md = 30px (a row), lg = 34px (the team strip). */
  size?: "md" | "lg";
}) {
  const dim = size === "lg" ? "h-8.5 w-8.5 text-xs" : "h-7.5 w-7.5 text-2xs";
  if (person.photo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={person.photo} alt="" loading="lazy" className={`${dim} flex-none rounded-full object-cover`} />
    );
  }
  const tint = TINTS[Math.abs(person.id) % TINTS.length];
  return (
    <span aria-hidden className={`${dim} ${tint} grid flex-none place-items-center rounded-full font-bold`}>
      {initialsOf(person.name)}
    </span>
  );
}
