import "server-only";

// The directory export: one prepared table, rendered to PDF or CSV.
//
// Server-generated on purpose. The old print path handed the browser a hidden
// table and hoped the print dialog did the rest — every machine produced a
// different document, dark mode printed white on white, and nothing an admin
// chose (paper, logo, sections) could be relied on. Here the preset decides
// and the bytes come out the same everywhere.
//
// Values go through the same display helpers as the screen, so a code that
// shows as "PHX1 – Phoenix" in a card is "PHX1 – Phoenix" on paper.

import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { ExportPreset } from "./directory-export-config";
import type { DirectoryField, DirectoryPerson } from "./directory";
import {
  cellValue,
  columnLabel,
  compareByKeys,
  groupPeople,
  initialsOf,
  pinnedFirst,
  rawValue,
  resolveValues,
} from "./directory-display";
import { officeBlocksFor, type OfficeBlock, type OfficeConfig } from "./directory-offices";
import { columnGeometry, planPages, type ExportLine } from "./directory-export-layout";

export interface ExportInput {
  preset: ExportPreset;
  people: DirectoryPerson[];
  fields: DirectoryField[];
  company: string;
  /** A data: URL of a PNG or JPEG logo, when the preset wants one and one exists. */
  logo: string | null;
  /** The "printed on" label, already formatted per workspace settings. */
  printedOn: string;
  /** Office profiles; the PDF closes with one block per office that appears in it. */
  offices?: OfficeConfig;
}

export type PreparedOffice = OfficeBlock;

export interface PreparedColumn {
  key: string;
  label: string;
  /** Relative width; derived from the longest value in the column. */
  weight: number;
}

export interface PreparedSection {
  label: string | null;
  rows: DirectoryPerson[];
}

export interface PreparedExport {
  title: string;
  subtitle: string;
  columns: PreparedColumn[];
  sections: PreparedSection[];
  total: number;
  /** In the Office field's option order, then by first appearance. Empty unless the preset asks. */
  offices: PreparedOffice[];
}

const PAPER: Record<ExportPreset["paper"], "LETTER" | "A4" | "LEGAL"> = {
  letter: "LETTER",
  a4: "A4",
  legal: "LEGAL",
};

const DENSITY: Record<ExportPreset["density"], { font: number; pad: number; head: number; photo: number }> = {
  compact: { font: 7.5, pad: 2, head: 7, photo: 16 },
  normal: { font: 8.5, pad: 3, head: 7.5, photo: 20 },
  comfortable: { font: 10, pad: 4.5, head: 8.5, photo: 24 },
};

/** Does a person match a preset filter? Compares the raw, canonical and label forms. */
function matchesFilter(p: DirectoryPerson, filter: ExportPreset["filter"], fields: DirectoryField[]): boolean {
  if (!filter) return true;
  const want = filter.value.trim().toLowerCase();
  const field = fields.find((f) => f.key === filter.key);
  if (field?.kind === "people" || filter.key === "assists" || filter.key.endsWith(":in")) {
    return cellValue(p, filter.key, fields).toLowerCase().split(", ").includes(want);
  }
  const raw = rawValue(p, filter.key);
  if (!field) return raw.trim().toLowerCase() === want;
  return resolveValues(field, raw).some(
    (r) => r.raw.toLowerCase() === want || r.value.toLowerCase() === want || r.label.toLowerCase() === want
  );
}

/** Filter, sort, group and size the table — shared by the PDF and the CSV. */
export function prepareExport(input: Omit<ExportInput, "logo" | "printedOn">): PreparedExport {
  const { preset, fields } = input;
  const visible = input.people.filter((p) => p.hidden !== 1 && matchesFilter(p, preset.filter, fields));
  const sorted = [...visible].sort(
    compareByKeys(fields, [
      { key: preset.sort, dir: preset.sort_dir === "desc" ? -1 : 1 },
      { key: preset.sort2, dir: preset.sort2_dir === "desc" ? -1 : 1 },
    ])
  );

  const sections: PreparedSection[] = [];
  const { pinned, rest } = preset.pinned_first ? pinnedFirst(sorted) : { pinned: [], rest: sorted };
  if (pinned.length) sections.push({ label: "Key contacts", rows: pinned });
  const groupField = preset.group_by ? fields.find((f) => f.key === preset.group_by && f.group_by) : undefined;
  if (groupField) {
    for (const g of groupPeople(rest, groupField)) sections.push({ label: `${g.label}`, rows: g.members });
  } else {
    sections.push({ label: null, rows: rest });
  }

  const columns: PreparedColumn[] = preset.columns.map((key) => {
    let longest = columnLabel(key, fields).length;
    for (const p of visible) longest = Math.max(longest, cellValue(p, key, fields).length);
    // Clamp so one long value can't starve the others, and give names room.
    const weight = Math.max(key === "name" ? 12 : 5, Math.min(34, longest));
    return { key, label: columnLabel(key, fields), weight };
  });

  return {
    title: preset.title || `${input.company} directory`,
    subtitle: preset.subtitle,
    columns,
    sections,
    total: visible.length,
    offices: preset.office_info ? officeBlocksFor(visible, fields.find((f) => f.key === "office"), input.offices) : [],
  };
}

const RASTER = /^data:image\/(png|jpe?g);base64,/i;
const ZEBRA = "#f5f7fa";

function DirectoryDocument({ input, prepared }: { input: ExportInput; prepared: PreparedExport }) {
  const { preset, fields } = input;
  const d = DENSITY[preset.density];
  const totalWeight = prepared.columns.reduce((s, c) => s + c.weight, 0) || 1;
  const photoCol = preset.photos ? d.photo + 6 : 0;
  const twoUp = preset.page_columns > 1;

  const styles = StyleSheet.create({
    page: {
      fontFamily: "Helvetica",
      fontSize: d.font,
      color: "#1e293b",
      paddingTop: 34,
      paddingHorizontal: 36,
      paddingBottom: 44,
    },
    header: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
    logo: { height: 22, maxWidth: 110, objectFit: "contain" },
    title: { fontFamily: "Helvetica-Bold", fontSize: d.font + 6, color: "#0f172a" },
    subtitle: { fontSize: d.font, color: "#64748b", marginTop: 1 },
    count: { marginLeft: "auto", fontSize: d.font - 0.5, color: "#94a3b8" },
    thead: {
      flexDirection: "row",
      borderBottomWidth: 1.2,
      borderBottomColor: "#94a3b8",
      paddingBottom: d.pad,
      marginBottom: 1,
    },
    th: {
      fontFamily: "Helvetica-Bold",
      fontSize: d.head,
      color: "#475569",
      textTransform: "uppercase",
      letterSpacing: 0.4,
      paddingRight: 5,
    },
    section: {
      fontFamily: "Helvetica-Bold",
      fontSize: d.font,
      color: "#0f172a",
      backgroundColor: "#e8edf3",
      paddingVertical: d.pad,
      paddingHorizontal: 4,
      marginTop: 6,
      textTransform: "uppercase",
      letterSpacing: 0.4,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      borderBottomWidth: 0.5,
      borderBottomColor: "#e2e8f0",
      paddingVertical: d.pad,
    },
    rowShaded: { backgroundColor: ZEBRA },
    td: { paddingRight: 5 },
    name: { fontFamily: "Helvetica-Bold", color: "#0f172a" },
    photoCell: { width: photoCol, paddingRight: 6 },
    photo: { width: d.photo, height: d.photo, borderRadius: d.photo / 2, objectFit: "cover" },
    initials: {
      width: d.photo,
      height: d.photo,
      borderRadius: d.photo / 2,
      backgroundColor: "#e2e8f0",
      color: "#475569",
      fontSize: Math.max(5, d.font - 2.5),
      textAlign: "center",
      paddingTop: d.photo / 2 - (d.font - 2.5) / 2 - 1,
    },
    columns: { flexDirection: "row", gap: preset.page_columns === 3 ? 14 : 18 },
    column: { flex: 1 },
    footer: {
      position: "absolute",
      left: 36,
      right: 36,
      bottom: 20,
      flexDirection: "row",
      justifyContent: "space-between",
      fontSize: d.font - 1,
      color: "#94a3b8",
    },
    officesHead: {
      fontFamily: "Helvetica-Bold",
      fontSize: d.head,
      color: "#475569",
      textTransform: "uppercase",
      letterSpacing: 0.4,
      marginTop: 16,
      paddingTop: 6,
      borderTopWidth: 1.2,
      borderTopColor: "#94a3b8",
    },
    officeRowOf: { flexDirection: "row", gap: 8, marginTop: 6 },
    office: {
      flex: 1,
      padding: d.pad + 3,
      borderWidth: 0.5,
      borderColor: "#cbd5e1",
      borderRadius: 3,
      backgroundColor: "#f8fafc",
    },
    officeName: { fontFamily: "Helvetica-Bold", fontSize: d.font + 1, color: "#0f172a", marginBottom: 3 },
    officeRows: { flexDirection: "row", flexWrap: "wrap" },
    officeRow: { width: "50%", paddingRight: 8, marginBottom: 2 },
    officeRowWide: { width: "100%", paddingRight: 8, marginBottom: 2 },
    officeLabel: { fontFamily: "Helvetica-Bold", fontSize: d.font - 1, color: "#64748b" },
    officeValue: { fontSize: d.font, color: "#1e293b" },
  });

  const width = (c: PreparedColumn) => `${((c.weight / totalWeight) * 100).toFixed(2)}%`;

  const header = (
    <View style={styles.header}>
      {preset.logo && input.logo && RASTER.test(input.logo) ? <Image src={input.logo} style={styles.logo} /> : null}
      <View>
        <Text style={styles.title}>{prepared.title}</Text>
        {prepared.subtitle ? <Text style={styles.subtitle}>{prepared.subtitle}</Text> : null}
      </View>
      <Text style={styles.count}>
        {prepared.total} {prepared.total === 1 ? "person" : "people"}
      </Text>
    </View>
  );

  const thead = (
    <View style={styles.thead}>
      {preset.photos ? <View style={styles.photoCell} /> : null}
      {prepared.columns.map((c) => (
        <Text key={c.key} style={[styles.th, { width: width(c) }]}>
          {c.label}
        </Text>
      ))}
    </View>
  );

  // Alternate rows are shaded so the eye keeps its line across a wide page;
  // the count restarts at every section, so a section always opens unshaded.
  const row = (p: DirectoryPerson, index: number, key: string) => (
    <View key={key} style={[styles.row, preset.zebra && index % 2 === 1 ? styles.rowShaded : {}]} wrap={false}>
      {preset.photos ? (
        <View style={styles.photoCell}>
          {p.photo && RASTER.test(p.photo) ? (
            <Image src={p.photo} style={styles.photo} />
          ) : (
            <Text style={styles.initials}>{initialsOf(p.name)}</Text>
          )}
        </View>
      ) : null}
      {prepared.columns.map((c) => (
        <Text
          key={c.key}
          style={[styles.td, c.key === "name" ? styles.name : {}, { width: width(c) }, twoUp ? { textOverflow: "ellipsis" } : {}]}
          {...(twoUp ? { maxLines: 1 } : {})}
        >
          {cellValue(p, c.key, fields)}
        </Text>
      ))}
    </View>
  );

  const sectionHead = (label: string, count: number, key: string) => (
    <View key={key} minPresenceAhead={40}>
      <Text style={styles.section}>
        {label} ({count})
      </Text>
    </View>
  );

  // Office blocks sit after the last row. Each is unbreakable: one that does
  // not fit in what is left of the page moves whole to the next. The heading
  // lives inside the first block's unit, so it moves with it rather than
  // being left alone at the foot of the previous page.
  // Blocks stand `office_columns` abreast; a row of blocks is one unbreakable
  // unit, and the heading rides with the first row. A lone full-width block
  // lays its fields two to a line; narrower blocks stack them.
  const perRow = preset.office_columns;
  const officeRows: PreparedOffice[][] = [];
  for (let i = 0; i < prepared.offices.length; i += perRow) officeRows.push(prepared.offices.slice(i, i + perRow));
  const offices = officeRows.map((group, gi) => (
    <View key={gi} wrap={false}>
      {gi === 0 ? <Text style={styles.officesHead}>Office information</Text> : null}
      <View style={styles.officeRowOf}>
        {group.map((o) => (
          <View key={o.name} style={styles.office}>
            <Text style={styles.officeName}>{o.name}</Text>
            <View style={styles.officeRows}>
              {o.rows.map((r) => (
                <View key={r.label} style={perRow === 1 && !r.multiline ? styles.officeRow : styles.officeRowWide}>
                  <Text style={styles.officeLabel}>{r.label}</Text>
                  <Text style={styles.officeValue}>{r.value}</Text>
                </View>
              ))}
            </View>
          </View>
        ))}
        {/* Pad the last row so its blocks keep the width of a full row. */}
        {Array.from({ length: perRow - group.length }, (_, i) => (
          <View key={`pad-${i}`} style={{ flex: 1 }} />
        ))}
      </View>
    </View>
  ));

  const footer = (
    <View style={styles.footer} fixed>
      <Text>{[preset.footer_note, input.company].filter(Boolean).join("  ·  ")}</Text>
      <Text
        render={({ pageNumber, totalPages }) =>
          [
            preset.printed_date ? `Printed ${input.printedOn}` : "",
            preset.page_numbers ? `Page ${pageNumber} of ${totalPages}` : "",
          ]
            .filter(Boolean)
            .join("  ·  ")
        }
      />
    </View>
  );

  const docProps = { title: prepared.title, author: input.company, subject: "Directory", creator: "CompassDocs" };

  if (!twoUp) {
    return (
      <Document {...docProps}>
        <Page size={PAPER[preset.paper]} orientation={preset.orientation} style={styles.page}>
          <View fixed>
            {header}
            {thead}
          </View>
          {prepared.sections.map((s, si) => (
            <View key={si}>
              {s.label !== null ? sectionHead(s.label, s.rows.length, `h-${si}`) : null}
              {s.rows.map((p, ri) => row(p, ri, `${si}-${p.id}`))}
            </View>
          ))}
          {offices}
          {footer}
        </Page>
      </Document>
    );
  }

  // Two or three columns per page: the table is dealt into columns of a
  // known height (see directory-export-layout), and each page is laid out
  // explicitly.
  const lines: ExportLine<DirectoryPerson>[] = [];
  for (const s of prepared.sections) {
    if (s.label !== null) lines.push({ kind: "section", label: s.label, count: s.rows.length });
    for (const p of s.rows) lines.push({ kind: "row", row: p });
  }
  const geometry = columnGeometry({
    paper: preset.paper,
    orientation: preset.orientation,
    font: d.font,
    pad: d.pad,
    head: d.head,
    photo: preset.photos ? d.photo : 0,
    hasSubtitle: Boolean(prepared.subtitle),
  });
  const pages = planPages(lines, geometry, preset.page_columns);

  return (
    <Document {...docProps}>
      {pages.map((pg, pi) => (
        <Page key={pi} size={PAPER[preset.paper]} orientation={preset.orientation} style={styles.page}>
          {header}
          <View style={styles.columns}>
            {pg.columns.map((col, ci) => {
              let shade = 0;
              return (
                <View key={ci} style={styles.column}>
                  {thead}
                  {col.lines.map((line, li) => {
                    if (line.kind === "section") {
                      shade = 0;
                      return sectionHead(line.label, line.count, `s-${pi}-${ci}-${li}`);
                    }
                    return row(line.row, shade++, `r-${pi}-${ci}-${line.row.id}`);
                  })}
                </View>
              );
            })}
          </View>
          {pi === pages.length - 1 ? offices : null}
          {footer}
        </Page>
      ))}
    </Document>
  );
}

/** The PDF bytes for an export. */
export async function renderDirectoryPdf(input: ExportInput): Promise<Buffer> {
  const prepared = prepareExport(input);
  return renderToBuffer(<DirectoryDocument input={input} prepared={prepared} />);
}

/**
 * The same table as CSV, UTF-8 with a BOM so Excel opens it correctly. A
 * leading =, +, - or @ is neutralised: a directory value that looks like a
 * formula must never execute when the file is opened in a spreadsheet.
 */
export function renderDirectoryCsv(input: Omit<ExportInput, "logo" | "printedOn">): string {
  const prepared = prepareExport(input);
  const grouped = prepared.sections.some((s) => s.label !== null);
  const cell = (v: string) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  lines.push([...(grouped ? ["Group"] : []), ...prepared.columns.map((c) => c.label)].map(cell).join(","));
  for (const s of prepared.sections) {
    for (const p of s.rows) {
      lines.push(
        [...(grouped ? [s.label ?? ""] : []), ...prepared.columns.map((c) => cellValue(p, c.key, input.fields))]
          .map(cell)
          .join(",")
      );
    }
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** A file name for the export: the preset's, else derived from its title. */
export function exportFilename(preset: ExportPreset, company: string, ext: "pdf" | "csv"): string {
  const base =
    preset.filename ||
    (preset.title || `${company} directory`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) ||
    "directory";
  return `${base}.${ext}`;
}
