"use client";

// The drop zone on a request_upload link. Three ways in, because the person
// arriving here is doing one small favour and should not have to work out how:
// drag a file onto it, click to browse, or paste (⌘V) a screenshot straight
// from the clipboard — which is the case this whole feature exists for.

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ImageUp, Loader2, TriangleAlert } from "lucide-react";

type State =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "done" }
  | { phase: "error"; message: string };

export function UploadDrop({
  token,
  docTitle,
  maxMb,
}: {
  token: string;
  docTitle: string;
  maxMb: number;
}) {
  const [state, setState] = useState<State>({ phase: "idle" });
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Paste anywhere on the page — a screenshot in the clipboard is the whole
  // point, and making people find the drop target first is friction for
  // nothing. The handler is registered once and reads the current send()
  // through a ref, so a re-render doesn't re-bind the listener.
  const sendRef = useRef<(f: File) => void>(() => {});
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const file = imageFrom(e.clipboardData?.items ?? null);
      if (file) sendRef.current(file);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // Revoke the object URL when it is replaced or the page goes away; without
  // this every retry leaks the previous image for the life of the tab.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  function imageFrom(items: DataTransferItemList | null): File | null {
    if (!items) return null;
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
    }
    return null;
  }

  async function send(file: File) {
    if (state.phase === "sending" || state.phase === "done") return;
    // Refuse oversize files here rather than uploading them to be told no —
    // the server checks again, this is only to save the round trip.
    if (file.size > maxMb * 1024 * 1024) {
      setState({
        phase: "error",
        message: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${maxMb} MB limit.`,
      });
      return;
    }
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
    setState({ phase: "sending" });
    const body = new FormData();
    body.append("file", file);
    try {
      const res = await fetch(`/api/upload-tickets/${encodeURIComponent(token)}`, {
        method: "POST",
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ phase: "error", message: data?.error || "The upload failed. Try again." });
        return;
      }
      setState({ phase: "done" });
    } catch {
      setState({ phase: "error", message: "The upload failed — check your connection and try again." });
    }
  }
  sendRef.current = (f: File) => void send(f);

  if (state.phase === "done") {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-xs">
        <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold text-slate-900">Image added</h1>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
          It&rsquo;s on <span className="font-medium text-slate-700">{docTitle}</span>. You can close
          this page — nothing else is needed.
        </p>
        {preview && (
          // A blob: URL of the file the person just chose — next/image has
          // nothing to optimize here and cannot load it.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt=""
            className="mx-auto mt-5 max-h-64 rounded-lg border border-slate-200"
          />
        )}
      </div>
    );
  }

  const busy = state.phase === "sending";

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">
        Add an image to {docTitle}
      </h1>
      <p className="mt-1 text-sm text-slate-500">
        Drop the file below, paste a screenshot, or choose one. It goes straight into the document.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = imageFrom(e.dataTransfer?.items ?? null);
          if (file) void send(file);
          else setState({ phase: "error", message: "That wasn't an image file." });
        }}
        className={`mt-5 rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          dragging ? "border-compass-500 bg-compass-50" : "border-slate-300 bg-white"
        } ${busy ? "opacity-60" : ""}`}
      >
        {busy ? (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-compass-600" aria-hidden />
            <p className="mt-3 text-sm font-medium text-slate-600">Uploading…</p>
          </>
        ) : (
          <>
            <ImageUp className="mx-auto h-8 w-8 text-slate-300" aria-hidden />
            <p className="mt-3 text-sm font-medium text-slate-600">
              Drag an image here, or paste it
            </p>
            <p className="mt-1 text-xs text-slate-400">
              PNG, JPEG, GIF or WebP · up to {maxMb} MB
            </p>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="mt-4 rounded-lg bg-compass-600 px-4 py-2 text-sm font-medium text-white hover:bg-compass-700"
            >
              Choose a file
            </button>
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Clear the input so choosing the same file again after an error
            // still fires a change event.
            e.target.value = "";
            if (file) void send(file);
          }}
        />
      </div>

      {state.phase === "error" && (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{state.message}</span>
        </p>
      )}

      <p className="mt-6 text-center text-xs text-slate-400">
        This link works once and expires an hour after it was created.
      </p>
    </div>
  );
}
