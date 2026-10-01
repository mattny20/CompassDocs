"use client";

// Account → Profile: display name, email, and avatar. Local accounts edit
// name/email here; SSO/SCIM accounts see them read-only (the identity
// provider owns them). Avatars are resized in the browser to a small square
// data: URL — no server-side image processing needed.

import { useRef, useState } from "react";
import { Spinner } from "@/components/Spinner";
import { buttonClass } from "@/components/Button";
import { Field, TextInput } from "@/components/form";
import { toast } from "@/components/Toasts";
import { useRouter } from "next/navigation";
import { Upload, X } from "lucide-react";
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
  const fileInput = useRef<HTMLInputElement>(null);

  const dirty = name !== initialName || email !== initialEmail;

  async function patch(body: object): Promise<boolean> {
    setBusy(true);
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
    toast("error", (await res.json().catch(() => null))?.error || "Couldn't save.");
    return false;
  }

  async function saveIdentity(e: React.FormEvent) {
    e.preventDefault();
    if (await patch({ name: name.trim(), email: email.trim() })) toast("ok", "Profile saved.");
  }

  async function pickAvatar(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      if (await patch({ avatar: dataUrl })) setAvatar(dataUrl);
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Couldn't process the image.");
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  async function removeAvatar() {
    if (await patch({ avatar: "" })) setAvatar("");
  }

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
              className={buttonClass("secondary")}
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
          <Field label="Display name" size="md" error={!managed && !name.trim() ? "A display name is required." : undefined}>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={managed || busy}
              maxLength={80}
              required
            />
          </Field>
          <Field label="Email" size="md">
            <TextInput
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={managed || busy}
              maxLength={200}
              placeholder="you@example.com"
            />
          </Field>
          <Field
            label="Username"
            size="md"
            help="Usernames are permanent — they anchor history, comments, and sign-in."
          >
            <TextInput value={username} disabled readOnly />
          </Field>
        </div>
        {!managed && (
          <div className="mt-4 flex items-center gap-3">
            <button
              type="submit"
              disabled={busy || !dirty || !name.trim()}
              className={buttonClass("primary")}
            >
              {busy && <Spinner size="sm" />} Save changes
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
