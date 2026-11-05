import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { answer } from "@/lib/handbook-api";
import { handbookOptions } from "@/lib/handbooks";

export const dynamic = "force-dynamic";

// The handbook editor's pickers (1.18.0).
//
//   GET → HandbookOptions: { can_create_workspace, spaces (the ones the
//         caller may own a handbook in), visible_spaces, groups,
//         policy_ack }. Needs handbook.manage somewhere.

export async function GET() {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  return answer(() => handbookOptions(gate));
}
