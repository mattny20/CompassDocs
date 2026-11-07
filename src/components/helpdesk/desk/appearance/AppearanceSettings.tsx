"use client";

// Desk settings → Appearance (1.19.4; mock-up t4; STYLEGUIDE §Helpdesk:
// desk background). How the desk looks for agents: background artwork (the
// library: uploads, newest first, then the built-ins Aurora, Night ridge
// and Sunrise), which one shows in light mode and in dark mode, the
// transparency (Solid, Subtle, Glass) and "Let agents choose their own".
// An upload or a removal acts at once (like the sign-in artwork); the
// choices are the page's one Save. Preview shows the unsaved choices on
// this desk until it is turned off, saved, or the page is left. GET/PUT
// /api/helpdesk/admin/appearance, POST …/art, DELETE …/art/[id]
// (settings.manage).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Sparkle, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { confirmDialog } from "@/components/Dialog";
import { Field, Select, Toggle } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { Segmented } from "@/components/Segmented";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import {
  HD_ART_LIBRARY_MAX,
  HD_DESK_LEVELS,
  HD_DESK_LEVEL_LABEL,
  heavyScrimNote,
  resolveDeskLook,
  type HdAppearanceAdminView,
  type HdAppearanceSettings,
  type HdArtView,
  type HdDeskLevel,
  type HdDeskTheme,
} from "@/lib/helpdesk/appearance-shared";
import { getJson, sendJson } from "../api";
import { ArtThumb, UploadTile, UploadTileLabel, uploadArt } from "./art-ui";
import { useDeskLook } from "./DeskLook";

const URL_ = "/api/helpdesk/admin/appearance";

const LEVEL_HINT: Record<HdDeskLevel, string> = {
  solid: "Plain panels: the artwork is hidden.",
  subtle: "Panels mostly solid, the artwork softly behind them.",
  glass: "Panels let the artwork show through.",
};

export function AppearanceSettings() {
  const [view, setView] = useState<HdAppearanceAdminView | null>(null);
  const [f, setF] = useState<HdAppearanceSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "upload" | `remove:${string}`>("");
  const [previewing, setPreviewing] = useState(false);
  const desk = useDeskLook();
  const router = useRouter();
  const setPreview = desk?.setPreview;
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify(f));
  useLeaveGuard(dirty, hasUnsavedChanges);

  const apply = useCallback(
    (v: HdAppearanceAdminView, resetForm: boolean) => {
      setView(v);
      if (resetForm) {
        setF(v.settings);
        markClean(JSON.stringify(v.settings));
      } else {
        // An upload or removal: keep the typed choices, but drop a reference to an artwork that went.
        setF((cur) => {
          if (!cur) return v.settings;
          const has = (r: string) => r === "none" || v.library.some((a) => a.ref === r);
          return { ...cur, light: has(cur.light) ? cur.light : "none", dark: has(cur.dark) ? cur.dark : "none" };
        });
      }
    },
    [markClean]
  );

  useEffect(() => {
    getJson<HdAppearanceAdminView>(URL_, "Couldn't load the appearance settings.")
      .then((v) => apply(v, true))
      .catch((e: Error) => setError(e.message));
  }, [apply]);

  const byRef = useMemo(() => new Map((view?.library ?? []).map((a) => [a.ref, a])), [view]);
  const artOf = useCallback((ref: string): HdArtView | null => byRef.get(ref) ?? null, [byRef]);

  // Preview: the unsaved choices on this desk, following the form.
  useEffect(() => {
    if (!setPreview) return;
    if (previewing && f) setPreview(resolveDeskLook(artOf(f.light), artOf(f.dark), f.level));
    else setPreview(undefined);
  }, [previewing, f, artOf, setPreview]);
  useEffect(() => () => setPreview?.(undefined), [setPreview]);

  if (error && !view) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!view || !f) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  const set = (patch: Partial<HdAppearanceSettings>) => {
    markDirty();
    setF({ ...f, ...patch });
  };

  async function save() {
    if (!f) return;
    setBusy("save");
    try {
      const v = await sendJson<HdAppearanceAdminView>(URL_, "PUT", f, "Couldn't save the appearance settings.");
      apply(v, true);
      setPreviewing(false);
      toast("ok", "Appearance saved.");
      // The desk's own look comes from the layout (this person's own choice may differ).
      router.refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function upload(file: File) {
    setBusy("upload");
    try {
      const r = await uploadArt<{ art: HdArtView; view: HdAppearanceAdminView }>(`${URL_}/art`, file);
      apply(r.view, false);
      toast("ok", `${r.art.label} added. Choose it for light or dark mode, then save.`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function remove(art: HdArtView) {
    const using = view ? (["light", "dark"] as const).filter((k) => view.settings[k] === art.ref) : [];
    const ok = await confirmDialog({
      title: `Remove ${art.label}?`,
      body: using.length
        ? `It's the desk's artwork in ${using.join(" and ")} mode now; that goes back to none. The picture is deleted from the server.`
        : "The picture is deleted from the server.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (ok !== true) return;
    setBusy(`remove:${art.ref}`);
    try {
      const v = await sendJson<HdAppearanceAdminView>(`${URL_}/art/${art.ref.slice("upload:".length)}`, "DELETE", undefined, "Couldn't remove the artwork.");
      apply(v, false);
      toast("ok", `${art.label} removed.`);
      if (using.length) router.refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const inUse = (ref: string) => f.light === ref || f.dark === ref;
  const full = view.uploads >= HD_ART_LIBRARY_MAX;
  const modeField = (theme: HdDeskTheme) => {
    const note = heavyScrimNote(artOf(f[theme]), theme, f.level);
    return (
      <Field label={theme === "light" ? "Light mode" : "Dark mode"} help={note ?? undefined}>
        <Select value={f[theme]} onChange={(e) => set(theme === "light" ? { light: e.target.value } : { dark: e.target.value })}>
          <option value="none">None</option>
          {view.library.map((a) => (
            <option key={a.ref} value={a.ref}>
              {a.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  };

  return (
    <PageContainer>
      <PageHeader icon={<Sparkle />} title="Appearance" subtitle="How the desk looks for your agents. Each agent can change it for themselves." />
      <div className="flex flex-col gap-4">
        <Card title="Background artwork" description="Shown behind the desk. JPG, PNG or WebP up to 8 MB, at least 1920 × 1080. It's stored on your server.">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]" aria-label="Artwork library" data-testid="appearance-library">
            {view.library.map((a) => {
              const on = inUse(a.ref);
              return (
                <li key={a.ref} className="relative min-w-0">
                  <ArtThumb art={a} selected={on} className="aspect-[5/3] w-full" />
                  <p className={`mt-1.5 text-sm ${on ? "font-semibold text-compass-700" : "text-slate-600"}`}>
                    {a.label} <span className={on ? "font-normal" : ""}>({a.builtin ? "built in" : "uploaded"})</span>
                    {on && (
                      <span className="sr-only">
                        , shown in {[f.light === a.ref && "light", f.dark === a.ref && "dark"].filter(Boolean).join(" and ")} mode
                      </span>
                    )}
                  </p>
                  {!a.builtin && (
                    // Positioned by a wrapper: [data-tt] makes the button itself position: relative.
                    <span className="absolute right-1.5 top-1.5">
                      <button
                        type="button"
                        onClick={() => remove(a)}
                        disabled={busy !== ""}
                        aria-label={`Remove ${a.label}`}
                        data-tt={`Remove ${a.label}`}
                        className={iconButtonClass("bordered", "sm", "shadow-xs")}
                      >
                        <X aria-hidden />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
            <li className="min-w-0">
              {full ? (
                <p className="grid aspect-[5/3] w-full place-items-center rounded-lg border-[1.5px] border-dashed border-slate-300 p-3 text-center text-xs text-slate-500">
                  The library holds {HD_ART_LIBRARY_MAX}. Remove one to upload another.
                </p>
              ) : (
                <UploadTile onFile={upload} busy={busy === "upload"} className="aspect-[5/3] w-full">
                  <UploadTileLabel>{busy === "upload" ? "Uploading…" : "Upload artwork"}</UploadTileLabel>
                </UploadTile>
              )}
            </li>
          </ul>
          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
            {modeField("light")}
            {modeField("dark")}
          </div>
        </Card>

        <Card title="Transparency">
          <Segmented<HdDeskLevel>
            label="Transparency"
            value={f.level}
            onChange={(level) => set({ level })}
            options={HD_DESK_LEVELS.map((l) => ({ value: l, label: HD_DESK_LEVEL_LABEL[l], hint: LEVEL_HINT[l] }))}
            className="flex-wrap"
          />
          <p className="mt-2 text-sm text-slate-500">
            Panels let the artwork show through, blurred so text stays easy to read. People who turn on Reduce transparency in their device settings always get Solid.
          </p>
          <div className="mt-4 border-t border-slate-100 pt-4">
            <Toggle
              label="Let agents choose their own"
              help="From their menu: your artwork, one of their own, or none."
              checked={f.agents_choose}
              onChange={(v) => set({ agents_choose: v })}
            />
          </div>
        </Card>
      </div>
      <SaveRow dirty={dirty} busy={busy === "save"} onSave={save} label="Save" className="mt-4">
        <Button
          variant="secondary"
          icon={previewing ? <EyeOff /> : <Eye />}
          aria-pressed={previewing}
          onClick={() => {
            const next = !previewing;
            setPreviewing(next);
            if (next) {
              if (desk?.plainOnly) toast("ok", "This device asks for less transparency or less data, so the preview stays plain here.");
              else if ((f.light === "none" && f.dark === "none") || f.level === "solid") toast("ok", "With no artwork, or with Solid, the desk is plain.");
            }
          }}
        >
          {previewing ? "Stop preview" : "Preview"}
        </Button>
      </SaveRow>
    </PageContainer>
  );
}
