import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { listMyTraining } from "@/lib/db";
import { slideCount } from "@/lib/training";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The signed-in user's assignments (any role — training is assigned TO people).
export async function GET() {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json({ error: "Training is not included in your license." }, { status: 402 });
  }
  const mine = await listMyTraining(user.id);
  return NextResponse.json({
    items: mine.map((m) => ({
      assignment_id: m.assignment_id,
      title: m.title,
      space_name: m.space_name,
      space_icon: m.space_icon,
      assigned_at: m.assigned_at,
      due_at: m.due_at,
      completed_at: m.completed_at,
      last_slide: m.last_slide,
      slide_count: slideCount(m.content),
    })),
  });
}
