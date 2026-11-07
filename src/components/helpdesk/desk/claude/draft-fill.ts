// Claude in the desk (1.20.0): what the reply box holds after a draft is put
// in it. A refined draft replaces the earlier Claude draft it still holds
// unchanged; anything the agent wrote stays. Otherwise the draft goes after
// what is there. Pure, client-safe (Composer.fill uses it; tested).

export function mergeDraft(had: string, next: string, previous?: string | null): string {
  const box = had.trim();
  const prev = (previous ?? "").trim();
  if (prev && box.includes(prev)) return box.replace(prev, () => next).trim();
  return box ? `${box}\n\n${next}` : next;
}
