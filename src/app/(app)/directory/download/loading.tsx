import { DownloadSkeleton } from "@/components/Skeleton";

// Overrides the directory's own skeleton (one folder up): a download link
// lands on one card, not a grid of people.
export default function Loading() {
  return <DownloadSkeleton />;
}
