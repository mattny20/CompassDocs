"use client";

// "My desk background" (1.19.4; mock-up t5; STYLEGUIDE §Helpdesk: desk
// background). A row in the desk's user menu opens a panel under the
// avatar: the workspace's artwork, their own (an upload only they see), or
// none, and their own transparency. Every change applies at once (PUT
// /api/helpdesk/me/appearance) and the desk repaints without a reload.
// Shown while the workspace lets agents choose, or while they still have
// an upload of their own (so they can always remove it).

import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, Trash2 } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { MenuItem, Popover } from "@/components/Popover";
import { RadioCards } from "@/components/PolicyFields";
import { Segmented } from "@/components/Segmented";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { Button } from "@/components/Button";
import {
  HD_ART_RULES,
  HD_DESK_LEVELS,
  HD_DESK_LEVEL_LABEL,
  workspaceArtLine,
  type HdDeskBgChoice,
  type HdDeskLevel,
  type HdMyDeskView,
} from "@/lib/helpdesk/appearance-shared";
import { getJson, sendJson } from "../api";
import { ArtThumb, UploadTile, uploadArt } from "./art-ui";
import { useDeskLook } from "./DeskLook";

const URL_ = "/api/helpdesk/me/appearance";

/** The user menu's row (inside AvailabilityMenu's extra slot, which closes the menu on data-closes-menu). */
export function DeskBackgroundMenuItem() {
  const ctx = useDeskLook();
  if (!ctx?.menu) return null;
  return (
    <MenuItem icon={<ImageIcon />} data-closes-menu="" onClick={() => ctx.setPanelOpen(true)}>
      Desk background…
    </MenuItem>
  );
}

/** The panel, anchored under the avatar (render inside a `relative` wrapper around the user menu). */
export function MyDeskBackgroundPanel({ anchor }: { anchor: React.RefObject<HTMLElement | null> }) {
  const ctx = useDeskLook();
  const open = !!ctx?.panelOpen;
  const close = useCallback(() => ctx?.setPanelOpen(false), [ctx]);
  // Escape hands focus back to the avatar button.
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) trigger.current = anchor.current?.querySelector<HTMLElement>("button[aria-haspopup='menu']") ?? null;
  }, [open, anchor]);
  return (
    <Popover open={open} onClose={close} triggerRef={trigger} role="dialog" label="My desk background" align="end" width="w-[min(21rem,calc(100vw-1.5rem))]" padding="p-4" className="mt-1 max-h-[calc(100dvh-4.5rem)] overflow-y-auto overscroll-contain">
      {open && <PanelBody />}
    </Popover>
  );
}

function PanelBody() {
  const ctx = useDeskLook();
  const [view, setView] = useState<HdMyDeskView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "upload" | "remove">("");
  // Removing deletes the files, so it asks first, in place (a modal would close this panel).
  const [asking, setAsking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const setLook = ctx?.setLook;

  const apply = useCallback(
    (v: HdMyDeskView) => {
      setView(v);
      setLook?.(v.look);
    },
    [setLook]
  );

  useEffect(() => {
    getJson<HdMyDeskView>(URL_, "Couldn't load your desk background.")
      .then((v) => setView(v))
      .catch((e: Error) => setError(e.message));
  }, []);

  // Focus moves into the panel once it has something to focus: the checked choice.
  useEffect(() => {
    if (!view) return;
    const el = root.current?.querySelector<HTMLElement>("input[type=radio]:checked, button");
    el?.focus();
  }, [view === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>;
  if (!view) return <LoadingRow className="py-6" />;

  async function save(patch: { choice?: HdDeskBgChoice; level?: HdDeskLevel | null }) {
    setBusy("save");
    try {
      apply(await sendJson<HdMyDeskView>(URL_, "PUT", patch, "Couldn't change your desk background."));
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function upload(file: File) {
    setBusy("upload");
    try {
      apply(await uploadArt<HdMyDeskView>(`${URL_}/art`, file));
      toast("ok", "Your artwork is on your desk. Only you see it.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    setAsking(false);
    setBusy("remove");
    try {
      apply(await sendJson<HdMyDeskView>(`${URL_}/art`, "DELETE", undefined, "Couldn't remove your artwork."));
      toast("ok", "Your artwork was removed.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const ws = workspaceArtLine(view.workspace.light, view.workspace.dark);
  const effectiveLevel = view.level ?? view.workspace.level;
  const own = view.own;
  const ownBlock = (
    <div className="flex items-center gap-2">
      {own && <ArtThumb art={own} selected={view.choice === "own"} className="h-13 w-21 shrink-0" />}
      <UploadTile
        onFile={upload}
        busy={busy === "upload"}
        label={own ? "Upload a different picture" : "Upload your own artwork"}
        data-tt={own ? "Upload a different picture" : "Upload your own artwork"}
        className="h-13 w-21 shrink-0"
      />
      {own && (
        <button type="button" onClick={() => setAsking(true)} disabled={!!busy} aria-label="Remove your artwork" data-tt="Remove your artwork" className={iconButtonClass("quiet", "sm", "hover-danger")}>
          <Trash2 aria-hidden />
        </button>
      )}
    </div>
  );

  return (
    <div ref={root} aria-busy={busy !== "" || undefined}>
      <h2 className="text-sm font-semibold text-slate-900">My desk background</h2>
      <p className="mb-3 text-xs text-slate-500">Only you see this.</p>
      {view.allowed ? (
        <>
          <RadioCards<HdDeskBgChoice>
            label="My desk background"
            name="hd-my-desk-bg"
            value={view.choice}
            onChange={(choice) => {
              // "My own" needs a picture first: the tile below it opens the picker.
              if (choice === "own" && !own) {
                root.current?.querySelector<HTMLButtonElement>("button[aria-label='Upload your own artwork']")?.click();
                return;
              }
              void save({ choice });
            }}
            options={[
              { value: "workspace", label: "Workspace artwork", description: ws ?? "Your workspace hasn't set one: the plain desk." },
              { value: "own", label: "My own", description: own ? own.label : HD_ART_RULES, extra: own ? ownBlock : undefined },
              { value: "none", label: "None", description: "Plain desk, no transparency" },
            ]}
          />
          {view.choice !== "own" && <div className="mt-2">{ownBlock}</div>}
          {view.choice !== "none" && (
            <>
              <p id="hd-my-desk-level" className="mb-1.5 mt-4 text-xs font-medium text-slate-500">
                Transparency
              </p>
              <Segmented<HdDeskLevel>
                size="sm"
                label="Transparency"
                value={effectiveLevel}
                onChange={(level) => void save({ level })}
                options={HD_DESK_LEVELS.map((l) => ({ value: l, label: HD_DESK_LEVEL_LABEL[l] }))}
              />
              {ctx?.plainOnly && (
                <p className="mt-2 text-xs text-slate-500">This device asks for less transparency or less data, so the desk stays plain here.</p>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-slate-600">Your admin has set the desk&apos;s background for everyone.</p>
          {own && (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-medium text-slate-500">Your artwork (not shown)</p>
              <div className="flex items-center gap-2">
                <ArtThumb art={own} className="h-13 w-21 shrink-0" />
                <button type="button" onClick={() => setAsking(true)} disabled={!!busy} className="link text-sm">
                  Remove it
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {asking && (
        <div role="group" aria-label="Remove your artwork?" className="mt-3 rounded-lg border border-slate-200 p-3">
          <p className="text-sm text-slate-700">Remove your artwork? The picture is deleted from the server.</p>
          <div className="mt-2 flex gap-2">
            <Button variant="danger" size="sm" onClick={remove} busy={busy === "remove"} data-autofocus="">
              Remove
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAsking(false)}>
              Keep it
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
