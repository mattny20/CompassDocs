// A user's face in the UI: their uploaded avatar when set, initials otherwise.
// Server-safe (no hooks) so it renders in both server and client components.

const SIZES = {
  sm: "h-8 w-8 text-xs",
  md: "h-12 w-12 text-lg",
  lg: "h-20 w-20 text-2xl",
} as const;

export function initialsOf(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function UserAvatar({
  name,
  avatar,
  size = "sm",
  className = "",
}: {
  name: string;
  /** data: URL, or empty for initials. */
  avatar?: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  if (avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatar}
        alt=""
        aria-hidden
        className={`${SIZES[size]} shrink-0 rounded-full object-cover ring-1 ring-slate-200 ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`grid ${SIZES[size]} shrink-0 place-items-center rounded-full bg-compass-100 font-bold text-compass-700 ${className}`}
    >
      {initialsOf(name)}
    </span>
  );
}
