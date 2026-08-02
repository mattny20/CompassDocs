"use client";

// The "Insert video" dialog behind the editor's Video toolbar button: paste a
// provider/file URL (with live detection feedback) or upload a video file,
// plus optional caption and poster. Replaces the old window.prompt().

import { useEffect, useRef, useState } from "react";
import { Film, UploadCloud, X } from "lucide-react";
import { videoEmbedUrl } from "@/lib/doc-blocks";

function providerName(url: string): string | null {
  const embed = videoEmbedUrl(url.trim());
  if (!embed) return null;
  if (embed.kind === "file") return "video file";
  const host = new URL(embed.url).hostname;
  if (host.includes("youtube")) return "YouTube";
  if (host.includes("vimeo")) return "Vimeo";
  if (host.includes("loom")) return "Loom";
  if (host.includes("sharepoint") || host.includes("microsoftstream")) return "SharePoint / Stream";
  if (host.includes("drive.google")) return "Google Drive";
  if (host.includes("wistia")) return "Wistia";
  if (host.includes("dailymotion")) return "Dailymotion";
  return "supported provider";
}

export function VideoInsertDialog({
  open,
  onClose,
  onInsert,
  onUploadVideo,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (attrs: { src: string; title: string; poster: string }) => void;
  /** Upload a video file, resolving to its serving URL (null on failure). */
  onUploadVideo?: (file: File) => Promise<string | null>;
}) {
  const [src, setSrc] = useState("");
  const [title, setTitle] = useState("");
  const [poster, setPoster] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSrc("");
    setTitle("");
    setPoster("");
    setError("");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const detected = src.trim() ? providerName(src) : null;

  async function pickFile(file: File | null) {
    if (!file || !onUploadVideo) return;
    if (!file.type.startsWith("video/")) {
      setError("That doesn't look like a video file.");
      return;
    }
    setError("");
    setUploading(true);
    const url = await onUploadVideo(file);
    setUploading(false);
    if (!url) {
      setError("Upload failed — check the video size limit in Settings.");
      return;
    }
    setSrc(url);
    if (!title) setTitle(file.name.replace(/\.[a-z0-9]+$/i, ""));
  }

  function insert(e: React.FormEvent) {
    e.preventDefault();
    const clean = src.trim();
    if (!clean) return;
    if (!videoEmbedUrl(clean)) {
      setError(
        "Unsupported URL. Use YouTube, Vimeo, Loom, SharePoint/Stream, Google Drive, Wistia, Dailymotion, a direct video file, or upload one."
      );
      return;
    }
    onInsert({ src: clean, title: title.trim(), poster: poster.trim() });
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-label="Insert video"
      className="cmd-scrim fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={insert}
        className="w-full max-w-md rounded-xl border border-slate-200 bg-surface p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <Film className="h-4 w-4 text-compass-600" aria-hidden /> Insert video
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mb-1 block text-xs font-medium text-slate-500">Video URL</label>
        <input
          autoFocus
          type="text"
          value={src}
          onChange={(e) => {
            setSrc(e.target.value);
            setError("");
          }}
          placeholder="https://www.youtube.com/watch?v=… or paste any supported link"
          className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-compass-400 focus:outline-none"
        />
        <p className="mt-1 min-h-4 text-xs">
          {src.trim() &&
            (detected ? (
              <span className="text-emerald-600">Detected: {detected}</span>
            ) : (
              <span className="text-amber-600">Not recognized yet — keep typing or upload.</span>
            ))}
        </p>

        {onUploadVideo && (
          <div className="mb-2 mt-1">
            <input
              ref={fileInput}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              <UploadCloud className="h-4 w-4" aria-hidden />
              {uploading ? "Uploading…" : "Upload a video file instead"}
            </button>
          </div>
        )}

        <label className="mb-1 mt-2 block text-xs font-medium text-slate-500">
          Caption (optional)
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm text-slate-800 focus:border-compass-400 focus:outline-none"
        />

        <label className="mb-1 mt-2 block text-xs font-medium text-slate-500">
          Poster image URL (optional, uploaded videos only)
        </label>
        <input
          type="text"
          value={poster}
          onChange={(e) => setPoster(e.target.value)}
          placeholder="https://… or /api/attachments/…"
          className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-compass-400 focus:outline-none"
        />

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!src.trim() || uploading}
            className="rounded-lg bg-compass-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-50"
          >
            Insert
          </button>
        </div>
      </form>
    </div>
  );
}
