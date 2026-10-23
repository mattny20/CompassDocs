// A directory export's download link lands here (1.15.0).
//
// /directory/download/<preset>[?format=csv|vcf] is the link an admin copies
// from Settings → Directory → Export (or anyone from the Directory page's
// Export menu) and pastes into an email or an intranet page. It is an
// ordinary signed-in page: requireUser sends a signed-out visitor through
// sign-in with this page as `?next=`, and they come back to it. Once here,
// ExportDownload fetches the file with their own session and hands it to
// the browser, so it lands in their downloads folder while they watch this
// page say so, with Back to home once it has. The file is built for the
// person who opens the link, never for whoever copied it: the same viewer
// scope as the Directory page's own Export menu.
//
// Everything the page can tell before fetching it says in words instead:
// an account that can't read the directory, or a preset that has been
// deleted since the link went out (which the export route would otherwise
// answer with the default preset).

import { BookUser, Download, FileX2, Home, Lock } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { userHolds } from "@/lib/access";
import { listFields } from "@/lib/directory";
import { viewerScope } from "@/lib/directory-viewer";
import { listExportPresets } from "@/lib/directory-export-config";
import { exportLinkFileLabel, exportLinkSplits, parseExportLinkFormat } from "@/lib/directory-export-link";
import { ExportDownload } from "@/components/ExportDownload";
import { EmptyState } from "@/components/form";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Directory download" };

function decoded(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default async function DirectoryDownloadPage({
  params,
  searchParams,
}: {
  params: Promise<{ preset: string }>;
  searchParams: Promise<{ format?: string | string[] }>;
}) {
  const user = await requireUser();
  const [{ preset: raw }, sp] = await Promise.all([params, searchParams]);
  const format = parseExportLinkFormat(sp.format);

  if (!(await userHolds(user, "directory.read", { legacyMin: "viewer" }))) {
    return (
      <PageContainer>
        <PageHeader icon={<Download />} title="Directory download" />
        <EmptyState
          icon={<Lock />}
          title="Your account can't export the directory"
          body="Ask an administrator for access to the directory, then open the link again."
          action={{ href: "/", label: "Back to home", icon: <Home /> }}
        />
      </PageContainer>
    );
  }

  // The viewer's own scope, as the export route reads it, so the preset is
  // looked up the same way the file will be made.
  const scope = await viewerScope(user, await listFields());
  const presets = await listExportPresets(scope.fields);
  // Next hands the segment over decoded; an id that needed encoding in the
  // link is matched either way.
  const preset = presets.find((p) => p.id === raw) ?? presets.find((p) => p.id === decoded(raw));

  if (!preset) {
    return (
      <PageContainer>
        <PageHeader icon={<Download />} title="Directory download" />
        <EmptyState
          icon={<FileX2 />}
          title="This download link no longer works"
          body="The export it points to has been removed. Ask whoever sent the link for a new one, or open the directory and export from there."
          action={{ href: "/directory", label: "Open the directory", icon: <BookUser /> }}
        />
      </PageContainer>
    );
  }

  // A preset split by section sends its PDF and its CSV as a ZIP.
  const split = exportLinkSplits(format, preset.split_by);
  const ext = split ? "zip" : format;
  return (
    <PageContainer>
      <PageHeader
        icon={<Download />}
        title={preset.name || "Directory download"}
        subtitle="Your copy of the company directory, made just now from what your account can see."
      />
      <ExportDownload
        presetId={preset.id}
        format={format}
        fileLabel={exportLinkFileLabel(format, split)}
        fallbackName={`directory.${ext}`}
      />
    </PageContainer>
  );
}
