"use client";

// /desk/assets (1.19.3): find an asset by tag, serial, name, model or person
// and open its page. Every asset when "Agents can search all assets" is on,
// otherwise the assets of people whose tickets the agent works. The trail
// on an asset's page leads here. GET /api/helpdesk/assets?q= (agents).

import { useEffect, useState } from "react";
import Link from "next/link";
import { Package, Search } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { Card } from "@/components/Card";
import { SectionEmpty, TextInput } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow } from "@/components/Spinner";
import { Table, TABLE_HEAD_ROW, Td, Th, TR } from "@/components/Table";
import { statusText, statusTone, type HdAsset } from "@/lib/helpdesk/assets-shared";
import { getJson } from "../api";
import { AssetGlyph, assetHref } from "./TicketAssets";

export function AssetSearch() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<HdAsset[] | null>([]);
  const [meta, setMeta] = useState<{ search_all: boolean; notice: string | null }>({ search_all: true, notice: null });
  const [error, setError] = useState("");

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setRows([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setRows(null);
      getJson<{ assets: HdAsset[]; search_all: boolean; notice: string | null }>(`/api/helpdesk/assets?q=${encodeURIComponent(term)}`, "Couldn't search the assets.", ctrl.signal)
        .then((r) => {
          setRows(r.assets);
          setMeta({ search_all: r.search_all, notice: r.notice });
          setError("");
        })
        .catch((e: Error) => {
          if (e.name !== "AbortError") {
            setError(e.message);
            setRows([]);
          }
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  return (
    <PageContainer>
      <PageHeader icon={<Package />} title="Assets" subtitle="Find a device by its tag, serial, name or the person who has it, and see its tickets." />
      <div className="relative mb-4 max-w-xl">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden />
        <TextInput type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Asset tag, serial or name" aria-label="Search assets" className="pl-9" autoFocus />
      </div>
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {meta.notice && <p className="notice-warn mb-4 rounded-lg border px-3 py-2 text-sm">{meta.notice}</p>}
      <Card padding="none">
        {rows === null ? (
          <LoadingRow className="py-6" />
        ) : rows.length === 0 ? (
          <SectionEmpty className="px-4 py-4">
            {q.trim() ? "No asset matches that." : meta.search_all ? "Type a tag, serial or name to search every asset." : "Type a tag, serial or name. You'll find the assets of people whose tickets you work."}
          </SectionEmpty>
        ) : (
          <Table scroll minWidth="40rem">
            <thead className={TABLE_HEAD_ROW}>
              <tr>
                <Th>Asset</Th>
                <Th>Assigned to</Th>
                <Th fit>Status</Th>
                <Th fit>Source</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className={TR}>
                  <Td>
                    <Link href={assetHref(a.id)} className="flex items-center gap-2.5 font-semibold text-slate-900 hover:underline">
                      <AssetGlyph a={a} size="sm" />
                      <span className="min-w-0">
                        {a.name}
                        <span className="block text-xs font-normal text-slate-500">{[a.tag, a.serial].filter(Boolean).join(" · ")}</span>
                      </span>
                    </Link>
                  </Td>
                  <Td>{a.assigned_name || "Nobody"}</Td>
                  <Td fit>{statusText(a) ? <span className={chipClass(statusTone(a.status_kind), "sm")}>{statusText(a)}</span> : null}</Td>
                  <Td fit>
                    <span className="text-slate-600">{a.provider_label}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </PageContainer>
  );
}
