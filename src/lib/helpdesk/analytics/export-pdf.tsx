// Helpdesk 1.19.0 reports (agent K): a dashboard as a PDF (STYLEGUIDE
// §Print: exports are files rendered on the server, not print dialogs).
// The numbers are the viewer's, from ./export runDashboard; the tiles
// print as a grid of headline numbers, every split as a table with an
// inline bar so the shape survives on paper and in grey. Light only.
// Server-only.

import "server-only";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { HD_COMPARE_LABEL, HD_DIMENSIONS, HD_MEASURES, formatValue, headline, type HdDashboard } from "./shared";
import type { DashboardState, WidgetResult } from "./export";

const INK = "#0f172a";
const MUTED = "#5a6980";
const LINE = "#e2e8f0";
const ACCENT = "#2e75bd";
const TRACK = "#edf5fb";

const s = StyleSheet.create({
  page: { padding: 36, fontSize: 9, color: INK, fontFamily: "Helvetica" },
  h1: { fontSize: 18, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  meta: { color: MUTED, marginBottom: 14 },
  tiles: { flexDirection: "row", flexWrap: "wrap", marginBottom: 8 },
  tile: { width: "25%", padding: 4 },
  tileBox: { borderWidth: 1, borderColor: LINE, borderRadius: 4, padding: 8 },
  tileLabel: { color: MUTED, fontSize: 8, marginBottom: 3 },
  tileValue: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  tileChange: { color: MUTED, fontSize: 8, marginTop: 2 },
  section: { marginTop: 10 },
  h2: { fontSize: 11, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: LINE, paddingVertical: 3, alignItems: "center" },
  head: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: MUTED, paddingBottom: 3 },
  th: { color: MUTED, fontSize: 8, fontFamily: "Helvetica-Bold" },
  label: { width: "38%", paddingRight: 6 },
  label2: { width: "22%", paddingRight: 6 },
  barCell: { flexGrow: 1, paddingRight: 6 },
  track: { height: 5, backgroundColor: TRACK, borderRadius: 2 },
  bar: { height: 5, backgroundColor: ACCENT, borderRadius: 2 },
  value: { width: 64, textAlign: "right" },
  note: { color: MUTED, fontSize: 8, marginTop: 2 },
  footer: { position: "absolute", bottom: 18, left: 36, right: 36, color: MUTED, fontSize: 7, flexDirection: "row", justifyContent: "space-between" },
});

const MAX_ROWS = 20;

// The standard PDF fonts are WinAnsi: no true minus or plus-minus sign.
const ascii = (s: string) => s.replace(/\u2212/g, "-").replace(/\u00b1/g, "+/-");

function DashboardPdf({ d, results, state, viewerName, generated }: { d: HdDashboard; results: WidgetResult[]; state: DashboardState; viewerName: string; generated: string }) {
  const first = results.find((x) => x.result)?.result;
  const tiles = results.filter((x) => x.result && !x.result.groupBy.length);
  const splits = results.filter((x) => x.result && x.result.groupBy.length);
  return (
    <Document title={d.name} author={viewerName} creator="CompassDocs">
      <Page size="A4" style={s.page}>
        <Text style={s.h1}>{d.name}</Text>
        <Text style={s.meta}>
          {first ? `${first.range.from} to ${first.range.to} (${first.range.timezone})` : ""}
          {state.compare ? ` · compared with ${HD_COMPARE_LABEL[state.compare].toLowerCase()}` : ""}
          {d.description ? `\n${d.description}` : ""}
        </Text>
        <View style={s.tiles}>
          {tiles.map(({ widget, result }) => {
            const h = headline(result!);
            return (
              <View key={widget.id} style={s.tile} wrap={false}>
                <View style={s.tileBox}>
                  <Text style={s.tileLabel}>{widget.title}</Text>
                  <Text style={s.tileValue}>{ascii(h.value)}</Text>
                  {h.change ? <Text style={s.tileChange}>{ascii(h.change)}</Text> : null}
                </View>
              </View>
            );
          })}
        </View>
        {splits.map(({ widget, result }) => {
          const r = result!;
          const rows = r.rows.slice(0, MAX_ROWS);
          const max = Math.max(1, ...rows.map((x) => Math.abs(x.value ?? 0)));
          const two = r.groupBy.length === 2;
          return (
            <View key={widget.id} style={s.section} wrap={rows.length > 12}>
              <Text style={s.h2}>{widget.title}</Text>
              <View style={s.head}>
                <Text style={[s.th, two ? s.label2 : s.label]}>{HD_DIMENSIONS[r.groupBy[0]].label}</Text>
                {two ? <Text style={[s.th, s.label2]}>{HD_DIMENSIONS[r.groupBy[1]].label}</Text> : null}
                <Text style={[s.th, s.barCell]}> </Text>
                <Text style={[s.th, s.value]}>{HD_MEASURES[r.measure].short}</Text>
              </View>
              {rows.map((row, i) => (
                <View key={i} style={s.row} wrap={false}>
                  <Text style={two ? s.label2 : s.label}>{row.labels[0]}</Text>
                  {two ? <Text style={s.label2}>{row.labels[1]}</Text> : null}
                  <View style={s.barCell}>
                    <View style={s.track}>
                      <View style={[s.bar, { width: `${Math.round((Math.abs(row.value ?? 0) / max) * 100)}%` }]} />
                    </View>
                  </View>
                  <Text style={s.value}>{formatValue(row.value, r.unit)}</Text>
                </View>
              ))}
              {r.rows.length > MAX_ROWS ? <Text style={s.note}>{`${r.rows.length - MAX_ROWS} more rows in the CSV export.`}</Text> : null}
            </View>
          );
        })}
        <View style={s.footer} fixed>
          <Text>{`Generated ${generated} by ${viewerName}`}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function dashboardPdf(d: HdDashboard, results: WidgetResult[], state: DashboardState, viewerName: string): Promise<Buffer> {
  const generated = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return renderToBuffer(<DashboardPdf d={d} results={results} state={state} viewerName={viewerName} generated={generated} />);
}
