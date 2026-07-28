"use client";

// Account → Profile: display name, email, and avatar. Local accounts edit
// name/email here; SSO/SCIM accounts see them read-only (the identity
// provider owns them). Avatars are resized in the browser to a small square
// data: URL — no server-side image processing needed.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Upload, X } from "lucide-react";
import { UserAvatar } from "./UserAvatar";

const AVATAR_PX = 128;

async function fileToAvatarDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("That file doesn't look like an image."));
      el.src = url;
    });
    // Cover-crop to a centered square, then downscale.
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_PX;
    canvas.height = AVATAR_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't process the image.");
    ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ProfileForm({
  initialName,
  initialEmail,
  initialAvatar,
  username,
  managed,
  providerLabel,
}: {
  initialName: string;
  initialEmail: string;
  initialAvatar: string;
  username: string;
  /** True for SSO/SCIM accounts — name/email locked to the identity provider. */
  managed: boolean;
  providerLabel: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [avatar, setAvatar] = useState(initialAvatar);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<null | "ok" | string>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const dirty = name !== initialName || email !== initialEmail;

  async function patch(body: object): Promise<boolean> {
    setBusy(true);
    setSaved(null);
    const res = await fetch("/api/account/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res.ok) {
      router.refresh();
      return true;
    }
    setSaved((await res.json().catch(() => null))?.error || "Couldn't save.");
    return false;
  }

  async function saveIdentity(e: React.FormEvent) {
    e.preventDefault();
    if (await patch({ name: name.trim(), email: email.trim() })) setSaved("ok");
  }

  async function pickAvatar(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setSaved(null);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      if (await patch({ avatar: dataUrl })) setAvatar(dataUrl);
    } catch (err) {
      setSaved(err instanceof Error ? err.message : "Couldn't process the image.");
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  async function removeAvatar() {
    if (await patch({ avatar: "" })) setAvatar("");
  }

  const input =
    "w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-compass-400 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-surface p-5 shadow-xs">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Photo</h3>
        <p className="mb-3 text-sm text-slate-500">
          Shown in the sidebar and anywhere your initials appear today.
        </p>
        <div className="flex items-center gap-4">
          <UserAvatar name={name || username} avatar={avatar} size="lg" />
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => pickAvatar(e.target.files)}
            />
            <button
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" /> Upload photo
            </button>
            {avatar && (
              <button
                onClick={removeAvatar}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" /> Remove
              </button>
            )}
          </div>
        </div>
      </div>

      <form onSubmit={saveIdentity} className="rounded-xl border border-slate-200 bg-surface p-5 shadow-xs">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Identity</h3>
        {managed ? (
          <p className="mb-3 text-sm text-slate-500">
            Your name and email are managed by {providerLabel} — change them there and they
            update here on your next sign-in.
          </p>
        ) : (
          <p className="mb-3 text-sm text-slate-500">
            How you appear in bylines, comments, and the directory.
          </p>
        )}
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Display name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={managed || busy}
              maxLength={80}
              required
              className={input}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={managed || busy}
              maxLength={200}
              placeholder="you@example.com"
              className={input}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Username</span>
            <input value={username} disabled className={input} />
            <span className="mt-1 block text-xs text-slate-400">
              Usernames are permanent — they anchor history, comments, and sign-in.
            </span>
          </label>
        </div>
        {!managed && (
          <div className="mt-4 flex items-center gap-3">
            <button
              type="submit"
              disabled={busy || !dirty || !name.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-compass-700 disabled:opacity-50"
            >
              {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />} Save changes
            </button>
            {saved === "ok" && <span className="text-sm text-green-600">Saved.</span>}
          </div>
        )}
        {saved && saved !== "ok" && <p className="mt-3 text-sm text-red-600">{saved}</p>}
      </form>
    </div>
  );
}
