// The one back link: an arrow and the destination's own name ("Directory",
// "Production Deployment SOP"), never "Back to X". Sits above the page title
// on sub-pages (a person's team, a document's history, a training
// transcript) and is hidden in print. Server-safe.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export function BackLink({
  href,
  label,
  className = "mb-4",
}: {
  href: string;
  /** The destination's name. */
  label: React.ReactNode;
  /** Replaces the default bottom margin when the link sits in a flex row. */
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 text-sm text-slate-500 transition hover:text-slate-700 print:hidden ${className}`}
    >
      <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden /> {label}
    </Link>
  );
}
