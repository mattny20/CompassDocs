"use client";

// Settings → Workspace → Sign-in page (1.16.0, STYLEGUIDE §Settings pages).
// Four cards and a live preview: the artwork (upload, focus point, side,
// whether the name shows over it), the text over the artwork, the help
// under the form, and, for whoever may read the single sign-on settings,
// how people will actually sign in. The artwork's upload and removal apply
// at once, like the logo; everything else waits for the page's one Save.
// The preview is the real sign-in page in an iframe (PreviewFrame), fed the
// unsaved values through its address.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ExternalLink,
  ImageUp,
  Laptop,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Smartphone,
  Sun,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { CopyButton } from "@/components/CopyButton";
import { confirmDialog } from "@/components/Dialog";
import { Field, SectionEmpty, TextInput, Textarea, Toggle } from "@/components/form";
import { SaveRow } from "@/components/SaveRow";
import { Segmented } from "@/components/Segmented";
import { SettingsLink } from "@/components/SettingsLink";
import { toast } from "@/components/Toasts";
import { PreviewFrame, type PreviewPreset } from "@/components/auth/PreviewFrame";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import {
  FOCUS_LABEL,
  FOCUS_POINTS,
  helpUrlProblem,
  lengthProblem,
  normalizeSignInText,
  type ArtSide,
  type Focus,
  type SignInText,
  type SignInTextKey,
} from "@/lib/sign-in-text";
import type { SignInRoutingSummary, SignInRoutingWarning } from "@/lib/sign-in-routing-summary";

/** The stored artwork, as the page needs it. */
export interface SignInArtInfo {
  version: string;
  /** 0 when unknown (an upload from before the size was kept). */
  width: number;
  height: number;
}

/** Mirrors lib/sign-in-art ART_MAX_BYTES (server-only): refused here before a byte is sent. */
const ART_MAX_BYTES = 15 * 1024 * 1024;
/** Narrower than this reads soft on a 2560 or 3440 cover. */
const ART_SHARP_WIDTH = 2560;
const ART_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

/** Text fields in the order they appear, so a refusal focuses the first one. */
const TEXT_KEYS: SignInTextKey[] = ["headline", "tagline", "caption", "example", "help", "help_url"];

type Errors = Partial<Record<SignInTextKey, string>>;

/** The same refusals the save route makes (lib/sign-in-text). `all` adds the link check. */
function problems(s: SignInText, all: boolean): Errors {
  const out: Errors = {};
  for (const k of TEXT_KEYS) {
    const p = lengthProblem(k, normalizeSignInText(s[k]));
    if (p) out[k] = p;
  }
  if (all && !out.help_url) {
    const p = helpUrlProblem(normalizeSignInText(s.help_url));
    if (p) out.help_url = p;
  }
  return out;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function SignInPageSettings({
  initial,
  art: initialArt,
  routing,
}: {
  initial: SignInText;
  art: SignInArtInfo | null;
  /** Null when the viewer may not read the single sign-on settings. */
  routing: SignInRoutingSummary | null;
}) {
  const router = useRouter();
  const [s, setS] = useState<SignInText>(initial);
  const [art, setArt] = useState<SignInArtInfo | null>(initialArt);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [tried, setTried] = useState(false);
  const [serverErrors, setServerErrors] = useState<Errors>({});

  const fileRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"upload" | "replace" | null>(null);
  const fieldRefs = useRef<Partial<Record<SignInTextKey, HTMLInputElement | HTMLTextAreaElement | null>>>({});

  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify(s));
  useLeaveGuard(dirty, hasUnsavedChanges);

  /** User edits only: the artwork's upload and removal persist on their own. */
  function set<K extends keyof SignInText>(key: K, value: SignInText[K]) {
    markDirty();
    setS((prev) => ({ ...prev, [key]: value }));
    setServerErrors((prev) => {
      if (!(key in prev)) return prev;
      const rest = { ...prev };
      delete rest[key as SignInTextKey];
      return rest;
    });
  }

  // Over-long text is flagged as it is typed; a malformed link once a save
  // was tried (it is half-typed until then). The server's word wins.
  const errors: Errors = { ...problems(s, tried), ...serverErrors };
  const err = (k: SignInTextKey) => errors[k];
  const textProps = (k: SignInTextKey) => ({
    ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      fieldRefs.current[k] = el;
    },
    value: s[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(k, e.target.value),
  });

  function focusFirst(errs: Errors) {
    const first = TEXT_KEYS.find((k) => errs[k]);
    if (first) fieldRefs.current[first]?.focus();
  }

  async function save() {
    setTried(true);
    const local = problems(s, true);
    if (Object.keys(local).length > 0) {
      focusFirst(local);
      return;
    }
    setSaving(true);
    let res: Response | null = null;
    let data: Record<string, unknown> = {};
    try {
      res = await fetch("/api/admin/branding/sign-in", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s),
      });
      data = await readJson(res);
    } catch {
      // Network failure: falls through to the generic sentence.
    }
    setSaving(false);
    if (!res?.ok) {
      const fields = (data.fields ?? {}) as Errors;
      if (Object.keys(fields).length > 0) {
        setServerErrors(fields);
        focusFirst(fields);
      }
      toast("error", typeof data.error === "string" ? data.error : "Couldn't save the sign-in page.");
      return;
    }
    markClean();
    if (data.value) setS(data.value as SignInText);
    setTried(false);
    toast("ok", "Sign-in page saved.");
    router.refresh();
  }

  // Focus never falls to <body> when the button that was used unmounts.
  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === "replace") replaceRef.current?.focus();
    else if (target === "upload") uploadRef.current?.focus();
  }, [art]);

  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > ART_MAX_BYTES) {
      toast("error", "Artwork is limited to 15 MB.");
      return;
    }
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    let res: Response | null = null;
    let data: Record<string, unknown> = {};
    try {
      res = await fetch("/api/admin/branding/artwork", { method: "POST", body: fd });
      data = await readJson(res);
    } catch {
      // Network failure: the fallback sentence below.
    }
    setUploading(false);
    if (!res?.ok || typeof data.version !== "string") {
      toast("error", typeof data.error === "string" ? data.error : "Couldn't upload the image.");
      return;
    }
    focusAfter.current = "replace";
    setArt({ version: data.version, width: Number(data.width) || 0, height: Number(data.height) || 0 });
    toast("ok", "Artwork uploaded.");
    router.refresh();
  }

  async function remove() {
    const ok = await confirmDialog({
      danger: true,
      title: "Remove the sign-in artwork?",
      body: "The sign-in page goes back to the pattern in your accent color, and the image is deleted from this server. This cannot be undone.",
      confirmLabel: "Remove artwork",
    });
    if (ok !== true) return;
    setRemoving(true);
    let res: Response | null = null;
    let data: Record<string, unknown> = {};
    try {
      res = await fetch("/api/admin/branding/artwork", { method: "DELETE" });
      data = await readJson(res);
    } catch {
      // Network failure: the fallback sentence below.
    }
    setRemoving(false);
    if (!res?.ok) {
      toast("error", typeof data.error === "string" ? data.error : "Couldn't remove the artwork.");
      return;
    }
    focusAfter.current = "upload";
    setArt(null);
    toast("ok", "Artwork removed.");
    router.refresh();
  }

  const pick = () => fileRef.current?.click();

  return (
    <>
      {/* A leaf container: no overlay lives under it (confirmDialog portals to <body>).
          @3xl (48rem): the Wide column (53rem) puts the preview beside the fields. */}
      <div className="@container">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @3xl:items-start">
          <div className="@3xl:sticky @3xl:top-6 @3xl:col-start-2 @3xl:row-start-1">
            <PreviewCard s={s} art={art} />
          </div>
          <div className="space-y-6 @3xl:col-start-1 @3xl:row-start-1">
            <Card
              id="artwork"
              className="scroll-mt-6"
              title="Artwork"
              description="A photo or illustration beside the sign-in form on larger screens, and a band above it on phones."
            >
              <div className="space-y-4">
                {art ? (
                  <>
                    <FocusPicker art={art} value={s.focus} onChange={(f) => set("focus", f)} />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        ref={replaceRef}
                        variant="secondary"
                        icon={<ImageUp />}
                        busy={uploading}
                        disabled={removing}
                        onClick={pick}
                      >
                        Replace image…
                      </Button>
                      <Button variant="danger" icon={<Trash2 />} busy={removing} disabled={uploading} onClick={remove}>
                        Remove artwork…
                      </Button>
                      {art.width > 0 && (
                        <span className="text-xs text-slate-500">
                          {art.width} × {art.height} pixels
                        </span>
                      )}
                    </div>
                    {art.width > 0 && art.width < ART_SHARP_WIDTH && (
                      <p className="notice-warn rounded-lg border px-3 py-2 text-sm">
                        This image is {art.width} pixels wide, so it may look soft on large screens. 2560 pixels or
                        wider looks sharpest.
                      </p>
                    )}
                    <Toggle
                      label="Show the name and headline over the artwork"
                      help="Turn this off when the picture already carries your branding. The form then shows your logo and name instead."
                      checked={s.show_text}
                      onChange={(v) => set("show_text", v)}
                    />
                  </>
                ) : (
                  <>
                    <SectionEmpty>No artwork yet. The sign-in page uses a pattern in your accent color.</SectionEmpty>
                    <Button ref={uploadRef} variant="secondary" icon={<ImageUp />} busy={uploading} onClick={pick}>
                      Upload image…
                    </Button>
                  </>
                )}
                <div>
                  <span className="mb-1 block text-xs font-medium text-slate-500" aria-hidden>
                    Artwork side
                  </span>
                  <Segmented<ArtSide>
                    label="Artwork side"
                    value={s.side}
                    onChange={(v) => set("side", v)}
                    options={[
                      { value: "start", label: "Left", icon: PanelLeft },
                      { value: "end", label: "Right", icon: PanelRight },
                    ]}
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    On screens 1024 pixels and wider. Phones show the artwork as a band above the form.
                  </p>
                </div>
                <p className="text-xs text-slate-500">
                  JPEG, PNG, WebP or GIF, up to 15 MB, at least 1280 × 720 pixels and at most 100 megapixels. 2560 pixels or wider looks sharpest.
                  We make smaller copies for phones, keep only the first frame of an animation, and remove location and
                  camera data.
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept={ART_ACCEPT}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(e) => {
                    void upload(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
            </Card>

            <Card
              id="sign-in-text"
              className="scroll-mt-6"
              title="Text on the artwork"
              description="Shown over the artwork on screens 1024 pixels and wider, on a shade that keeps it readable on any picture."
            >
              {art && !s.show_text && (
                <p className="mb-3 text-xs text-slate-500">
                  Hidden while Show the name and headline over the artwork is off.
                </p>
              )}
              <div className="space-y-4">
                <Field
                  label="Headline (optional)"
                  help="Set large over the artwork. Leave blank to show the workspace name."
                  error={err("headline")}
                  size="lg"
                >
                  <TextInput {...textProps("headline")} autoComplete="off" />
                </Field>
                <Field label="Tagline (optional)" help="A sentence under the headline." error={err("tagline")} size="lg">
                  <Textarea {...textProps("tagline")} rows={2} />
                </Field>
                <Field
                  label="Caption (optional)"
                  help="Small print under the tagline, such as a photo credit."
                  error={err("caption")}
                  size="lg"
                >
                  <TextInput {...textProps("caption")} autoComplete="off" />
                </Field>
              </div>
            </Card>

            <Card id="sign-in-help" className="scroll-mt-6" title="Sign-in help" description="Shown with the sign-in form at every size.">
              <div className="space-y-4">
                <Field
                  label="Example email (optional)"
                  help="Shown faintly in the empty Email or username field, such as name@acme.com."
                  error={err("example")}
                  size="md"
                >
                  <TextInput {...textProps("example")} autoComplete="off" spellCheck={false} />
                </Field>
                <Field
                  label="Help text (optional)"
                  help={
                    <>
                      Under the sign-in form, such as who to contact. Left blank, password steps say &ldquo;Forgot your
                      password? Ask your administrator to reset it.&rdquo;
                    </>
                  }
                  error={err("help")}
                  size="lg"
                >
                  <Textarea {...textProps("help")} rows={2} />
                </Field>
                <Field
                  label="Help link (optional)"
                  help="An https:// or mailto: address. The help text becomes a link to it."
                  error={err("help_url")}
                  size="lg"
                >
                  <TextInput {...textProps("help_url")} type="url" inputMode="url" autoComplete="off" spellCheck={false} />
                </Field>
              </div>
            </Card>

            {routing && <RoutingCard routing={routing} />}
          </div>
        </div>
      </div>
      <SaveRow className="mt-6" dirty={dirty} busy={saving} onSave={save} label="Save changes" />
    </>
  );
}

/**
 * The focal point (STYLEGUIDE §Settings pages): nine named cells over the
 * whole, uncropped picture. One tab stop, arrows move in two dimensions,
 * and the choice follows focus like any radio group.
 */
function FocusPicker({ art, value, onChange }: { art: SignInArtInfo; value: Focus; onChange: (f: Focus) => void }) {
  const helpId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const known = art.width > 0 && art.height > 0;
  const ratio = known ? art.width / art.height : 16 / 9;

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    let next = -1;
    if (e.key === "ArrowRight") next = col < 2 ? i + 1 : i;
    else if (e.key === "ArrowLeft") next = col > 0 ? i - 1 : i;
    else if (e.key === "ArrowDown") next = row < 2 ? i + 3 : i;
    else if (e.key === "ArrowUp") next = row > 0 ? i - 3 : i;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = FOCUS_POINTS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    if (next !== i) onChange(FOCUS_POINTS[next]);
    refs.current[next]?.focus();
  }

  return (
    <fieldset>
      <legend className="mb-1 block text-xs font-medium text-slate-500">Keep in view</legend>
      <div
        className="relative rounded-lg bg-slate-100 ring-1 ring-slate-200"
        style={{
          aspectRatio: known ? `${art.width} / ${art.height}` : "16 / 9",
          width: `min(100%, 28rem, calc(20rem * ${ratio}))`,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/brand/artwork?w=960&v=${art.version}`}
          alt=""
          className="absolute inset-0 h-full w-full rounded-lg object-contain"
        />
        <div
          role="radiogroup"
          aria-label="Keep in view"
          aria-describedby={helpId}
          className="absolute inset-0 grid grid-cols-3 grid-rows-3"
        >
          {FOCUS_POINTS.map((f, i) => {
            const chosen = f === value;
            return (
              <button
                key={f}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={chosen}
                aria-label={FOCUS_LABEL[f]}
                tabIndex={chosen ? 0 : -1}
                onClick={() => {
                  if (!chosen) onChange(f);
                }}
                onKeyDown={(e) => onKeyDown(e, i)}
                className="group grid place-items-center"
              >
                {/* Literal white and black: the dots sit on the picture, which does not follow the theme. */}
                <span
                  aria-hidden
                  className={
                    chosen
                      ? "h-4 w-4 rounded-full border-2 border-white bg-compass-600 shadow-float"
                      : "h-2.5 w-2.5 rounded-full bg-white/40 ring-1 ring-black/30 transition group-hover:bg-white/80 group-focus-visible:bg-white/80"
                  }
                />
              </button>
            );
          })}
        </div>
      </div>
      <p id={helpId} className="mt-1 text-xs text-slate-500">
        The part of the picture that stays in view when a screen crops it.
      </p>
    </fieldset>
  );
}

/** The live preview: the real sign-in page at a real device size, with the unsaved values. */
function PreviewCard({ s, art }: { s: SignInText; art: SignInArtInfo | null }) {
  const [preset, setPreset] = useState<PreviewPreset>("laptop");
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Start in the theme the admin is looking at the settings in.
  useEffect(() => {
    if (document.documentElement.getAttribute("data-theme") === "dark") setTheme("dark");
  }, []);

  const query = useMemo(() => {
    const p = new URLSearchParams({
      art: art ? art.version : "none",
      headline: s.headline,
      tagline: s.tagline,
      caption: s.caption,
      help: s.help,
      help_url: s.help_url,
      example: s.example,
      focus: s.focus,
      side: s.side,
      text: s.show_text ? "1" : "0",
    });
    return p.toString();
  }, [s, art]);

  return (
    <Card title="Preview" description="With your unsaved changes.">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented<PreviewPreset>
          size="sm"
          label="Preview size"
          value={preset}
          onChange={setPreset}
          className="flex-wrap"
          options={[
            { value: "laptop", label: "Laptop", icon: Laptop },
            { value: "ultrawide", label: "Ultrawide", icon: Monitor },
            { value: "phone", label: "Phone", icon: Smartphone },
          ]}
        />
        <Segmented<"light" | "dark">
          size="sm"
          label="Preview theme"
          value={theme}
          onChange={setTheme}
          className="flex-wrap"
          options={[
            { value: "light", label: "Light", icon: Sun },
            { value: "dark", label: "Dark", icon: Moon },
          ]}
        />
        <a
          href={`/login/preview?${query}`}
          target="_blank"
          rel="noopener"
          className="link ml-auto inline-flex items-center gap-1 text-sm"
        >
          Open full-size preview
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
      <PreviewFrame src={`/login/preview?frame=1&theme=${theme}&${query}`} preset={preset} />
      <p className="mt-2 text-xs text-slate-500">What you type in the preview is never sent anywhere.</p>
    </Card>
  );
}

const WARNING_TEXT: Record<SignInRoutingWarning, React.ReactNode> = {
  unusable: (
    <>
      Single sign-on is set up but can&apos;t be used until you add your email domains in{" "}
      <SettingsLink href="/admin/sso">Single sign-on</SettingsLink>.
    </>
  ),
  no_domains: (
    <>
      No email domains are set for single sign-on, so new colleagues are asked for a password they don&apos;t have.
      Add your email domains in <SettingsLink href="/admin/sso">Single sign-on</SettingsLink>.
    </>
  ),
};

/** Read-only: what lib/sign-in-routing will do with what people type (needs identity.sso_read). */
function RoutingCard({ routing }: { routing: SignInRoutingSummary }) {
  return (
    <Card title="How people sign in" description="From your single sign-on settings.">
      <div className="space-y-2 text-sm text-slate-700">
        {routing.sentences.map((line) => (
          <p key={line} className="wrap-anywhere">
            {line}
          </p>
        ))}
      </div>
      {routing.localUrl && <CopyButton text={routing.localUrl} label="Copy link" className="mt-3" />}
      {routing.warnings.map((w) => (
        <p key={w} className="notice-warn mt-3 rounded-lg border px-3 py-2 text-sm">
          {WARNING_TEXT[w]}
        </p>
      ))}
    </Card>
  );
}
