"use client";

// Following | Everything on the Latest tile (1.17.0). The choice lives in the
// address (?latest=everything) so the tile stays a server component and a
// reload keeps the view; the switch only rewrites the query string.

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Segmented } from "@/components/Segmented";

export type LatestView = "following" | "everything";

export function LatestViewSwitch({ value }: { value: LatestView }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function choose(next: LatestView) {
    if (next === value) return;
    const q = new URLSearchParams(params.toString());
    q.set("latest", next);
    startTransition(() => router.replace(`${pathname}?${q.toString()}`, { scroll: false }));
  }

  return (
    <Segmented
      label="Show updates from"
      size="sm"
      value={value}
      onChange={choose}
      className={pending ? "opacity-70" : ""}
      options={[
        { value: "following", label: "Following", hint: "Spaces you follow" },
        { value: "everything", label: "Everything", hint: "Every space you can read" },
      ]}
    />
  );
}
