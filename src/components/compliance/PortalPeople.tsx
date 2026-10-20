"use client";

// Compliance › People (B4, 1.12.0): each person's required and confirmed
// counts with their standing, as the one-page portal's People card showed
// them, and (E1, 1.13.0) how many of their outstanding confirmations are
// past their due date. The person record (F3) later links each row to its
// page.

import { Users, Check, CircleAlert, CalendarX2 } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { Card } from "@/components/Card";
import { SectionEmpty } from "@/components/form";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { Pager } from "@/components/Pager";
import { useState } from "react";
import { pageOf, usePortal, type PortalPageProps } from "./use-portal";
import { PortalFallback } from "./PortalFallback";

const PEOPLE_PAGE = 50;

export function PortalPeople({ licensed, canManageLicense = false }: PortalPageProps) {
  const portal = usePortal(licensed);
  const [peoplePage, setPeoplePage] = useState(0);
  if (!portal.data) return <PortalFallback licensed={licensed} canManageLicense={canManageLicense} portal={portal} />;
  const peopleRows = portal.data.users.filter((u) => u.required > 0);
  const peoplePager =
    peopleRows.length > PEOPLE_PAGE ? (
      <Pager page={peoplePage} limit={PEOPLE_PAGE} total={peopleRows.length} onPage={setPeoplePage} />
    ) : null;

  return (
    <Card title="People" icon={<Users />} padding="none">
      {peopleRows.length === 0 ? (
        <SectionEmpty className="px-4 py-6">
          No one has a confirmation pending or recorded yet.
        </SectionEmpty>
      ) : (
        <>
          {peoplePager && <div className="border-b border-slate-100 px-4 py-2">{peoplePager}</div>}
          <Table scroll>
            <thead className={TABLE_HEAD_ROW}>
              <tr>
                <Th>Person</Th>
                <Th fit align="right">
                  Required
                </Th>
                <Th fit align="right">
                  Confirmed
                </Th>
                <Th fit align="right">
                  Overdue
                </Th>
                <Th fit align="right">
                  Standing
                </Th>
              </tr>
            </thead>
            <tbody>
              {pageOf(peopleRows, peoplePage, PEOPLE_PAGE).map((u) => (
                <tr key={u.id} className={TR}>
                  <Td className="font-medium text-slate-700">
                    {u.name || u.username}
                    <span className="ml-1.5 text-xs font-normal text-slate-500">{u.role}</span>
                  </Td>
                  <Td fit align="right" className="text-slate-500">
                    {u.required}
                  </Td>
                  <Td fit align="right" className="text-slate-600">
                    {u.acked}
                  </Td>
                  <Td fit align="right">
                    {/* Overdue (E1): the state chip when any confirmation is
                        past its date and grace; a plain 0 otherwise, so the
                        column reads as a count and the chip as the alarm. */}
                    {(u.overdue ?? 0) > 0 ? (
                      <span className={chipClass("error")}>
                        <CalendarX2 className="h-3 w-3" aria-hidden /> {u.overdue} overdue
                      </span>
                    ) : (
                      <span className="text-slate-500">0</span>
                    )}
                  </Td>
                  <Td fit align="right">
                    {u.acked >= u.required ? (
                      <span className={chipClass("ok")}>
                        <Check className="h-3 w-3" aria-hidden /> Compliant
                      </span>
                    ) : (
                      <span className={chipClass("warn")}>
                        <CircleAlert className="h-3 w-3" aria-hidden /> {u.required - u.acked} outstanding
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {peoplePager && <div className="border-t border-slate-100 px-4 py-2">{peoplePager}</div>}
        </>
      )}
    </Card>
  );
}
