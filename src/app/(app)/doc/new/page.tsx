import Link from "next/link";
import { FileText, LayoutTemplate } from "lucide-react";
import { listSpaces, getSpaceBySlug, getApprovalMode, listAllSpaceCategories } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { editableScopeFor } from "@/lib/access";
import { roleAtLeast, DOC_TYPE_LABEL } from "@/lib/types";
import { listTemplates, renderTemplate, type DocTemplate } from "@/lib/doc-templates";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate } from "@/lib/format";
import { DocEditor } from "@/components/DocEditor";

export const dynamic = "force-dynamic";

export default async function NewDocPage({
  searchParams,
}: {
  searchParams: Promise<{ space?: string; template?: string }>;
}) {
  const user = await requireRole("editor");
  const { space, template: tplParam } = await searchParams;
  // Only spaces the user can author in are offered (per-space edit rights).
  const spaces = await listSpaces(await editableScopeFor(user));
  if (spaces.length === 0) {
    return (
      <div className="mx-auto max-w-xl px-8 py-16 text-center">
        <h1 className="text-xl font-bold text-slate-900">No editable spaces</h1>
        <p className="mt-2 text-slate-500">
          You have the editor role, but no space currently grants you edit access. Ask an
          admin to add you (or one of your groups) to a space&apos;s editors.
        </p>
        <Link href="/" className="mt-4 inline-block font-medium text-compass-700 hover:underline">
          ← Back to dashboard
        </Link>
      </div>
    );
  }
  const spaceIds = new Set(spaces.map((s) => s.id));
  const categories = (await listAllSpaceCategories()).filter((c) => spaceIds.has(c.space_id));
  const bySlug = space ? await getSpaceBySlug(space) : undefined;
  // Ignore a ?space= preselection the user can't author in.
  const preselected = bySlug && spaces.some((s) => s.id === bySlug.id) ? bySlug : undefined;
  const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";

  const templates = await listTemplates(false);

  // ?template= is "blank", "pick" (force the chooser), or a template id.
  // With no param, a preselected space's default template applies automatically.
  let chosen: DocTemplate | undefined;
  let showPicker = false;
  if (tplParam === "pick") {
    showPicker = templates.length > 0;
  } else if (tplParam && tplParam !== "blank") {
    chosen = templates.find((t) => t.id === Number(tplParam));
    if (!chosen) showPicker = templates.length > 0;
  } else if (!tplParam) {
    const defId = preselected?.default_template_id;
    chosen = defId ? templates.find((t) => t.id === defId) : undefined;
    if (!chosen && templates.length > 0) showPicker = true;
  }

  const spaceQS = preselected ? `&space=${encodeURIComponent(preselected.slug)}` : "";

  if (showPicker) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 sm:px-8">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">New document</h1>
        <p className="mt-1 text-slate-500 dark:text-slate-400">
          Start from a template, or begin with a blank page.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Link
            href={`/doc/new?template=blank${spaceQS}`}
            className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-compass-300 hover:shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:hover:border-compass-600"
          >
            <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
              <FileText className="h-4 w-4 text-slate-400 group-hover:text-compass-600" aria-hidden />
              Blank document
            </div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              An empty page — bring your own structure.
            </p>
          </Link>
          {templates.map((t) => (
            <Link
              key={t.id}
              href={`/doc/new?template=${t.id}${spaceQS}`}
              className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-compass-300 hover:shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:hover:border-compass-600"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
                  <LayoutTemplate
                    className="h-4 w-4 text-slate-400 group-hover:text-compass-600"
                    aria-hidden
                  />
                  {t.name}
                </div>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {DOC_TYPE_LABEL[t.doc_type]}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t.description}</p>
            </Link>
          ))}
        </div>
      </div>
    );
  }

  const targetSpace = preselected ?? spaces[0];
  const settings = await getAppSettings();
  const rendered = chosen
    ? renderTemplate(chosen, {
        author: user.name || user.username,
        space: targetSpace.name,
        date: formatDate(new Date().toISOString(), settings),
      })
    : undefined;

  return (
    <div>
      {chosen && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-slate-50 px-6 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 sm:px-8">
          <span className="inline-flex items-center gap-1.5">
            <LayoutTemplate className="h-4 w-4 text-slate-400" aria-hidden />
            Template: <strong className="font-semibold">{chosen.name}</strong>
          </span>
          <Link href={`/doc/new?template=pick${spaceQS}`} className="text-compass-700 hover:underline dark:text-compass-400">
            Choose another
          </Link>
          <Link href={`/doc/new?template=blank${spaceQS}`} className="text-compass-700 hover:underline dark:text-compass-400">
            Start blank
          </Link>
        </div>
      )}
      <DocEditor
        // Remount when the template choice changes — soft navigation reuses
        // the client component, which otherwise keeps the old prefill state.
        key={chosen?.id ?? "blank"}
        mode="create"
        canPublish={canPublish}
        spaces={spaces}
        categories={categories}
        initial={{
          space_id: targetSpace.id,
          title: rendered?.title ?? "",
          type: rendered?.type ?? "knowledge",
          status: "draft",
          summary: rendered?.summary ?? "",
          tags: rendered?.tags ?? [],
          content: rendered?.content ?? "",
          author: "",
        }}
      />
    </div>
  );
}
