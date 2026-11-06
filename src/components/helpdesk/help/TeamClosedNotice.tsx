// When the team that will answer is closed (1.19.0, agent L's office hours
// and holidays): one calm line above the form or the conversation, the
// calendar's own sentence ("The IT team is closed for Christmas Day. We'll
// reply from Mon 09:00."). Nothing while the team is open. Server-safe.

import { Clock } from "lucide-react";

export function TeamClosedNotice({ message, className = "" }: { message: string | null | undefined; className?: string }) {
  if (!message) return null;
  return (
    <p role="status" className={`notice-warn flex items-start gap-2 rounded-lg border px-3 py-2 text-sm print:hidden ${className}`.trim()}>
      <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </p>
  );
}
