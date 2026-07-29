import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  createStatusIncident,
  addStatusIncidentUpdate,
  resolveStatusIncident,
  getStatusIncident,
  listStatusServices,
} from "@/lib/db";
import { alertManualIncident } from "@/lib/status";
import { requestOrigin } from "@/lib/oauth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const SEVERITIES = ["outage", "degraded", "maintenance"];

// Manual incident comms (approvers and admins): declare an outage, post
// updates as it unfolds, resolve it when it's over. Declare + resolve alert
// the whole workspace through the notification pipeline.
export async function POST(req: Request) {
  const gate = await apiGuard("approver");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const action = String(body?.action ?? "declare");
  const author = user.name || user.username;

  if (action === "declare") {
    const serviceId = Number(body?.service_id);
    const title = String(body?.title ?? "").trim();
    const severity = String(body?.severity ?? "outage");
    if (!Number.isInteger(serviceId) || !title) {
      return NextResponse.json({ error: "service_id and title are required." }, { status: 400 });
    }
    if (!SEVERITIES.includes(severity)) {
      return NextResponse.json({ error: "Unknown severity." }, { status: 400 });
    }
    const service = (await listStatusServices()).find((s) => s.id === serviceId);
    if (!service) return NextResponse.json({ error: "Unknown service." }, { status: 404 });

    const id = await createStatusIncident({
      serviceId,
      title,
      severity,
      body: String(body?.body ?? ""),
      author,
    });
    // Internal systems have no poller — the declared incident IS their state.
    if (service.provider === "manual") {
      const { setServiceStatus } = await import("@/lib/db");
      await setServiceStatus(serviceId, { status: severity as any, detail: title, url: "" });
    }
    await audit({
      actor: actorFrom(user),
      action: "status.incident_declared",
      details: { service: service.name, title, severity },
      ip: ipFrom(req),
    });
    void alertManualIncident({
      serviceName: service.name,
      title,
      severity,
      resolved: false,
      origin: requestOrigin(req),
    }).catch(() => {});
    return NextResponse.json({ id }, { status: 201 });
  }

  const incidentId = Number(body?.incident_id);
  if (!Number.isInteger(incidentId)) {
    return NextResponse.json({ error: "incident_id required." }, { status: 400 });
  }

  if (action === "update") {
    const text = String(body?.body ?? "").trim();
    if (!text) return NextResponse.json({ error: "An update body is required." }, { status: 400 });
    const ok = await addStatusIncidentUpdate(incidentId, text, author);
    if (!ok) return NextResponse.json({ error: "Unknown incident." }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  if (action === "resolve") {
    const resolved = await resolveStatusIncident(incidentId, author);
    if (!resolved) {
      return NextResponse.json({ error: "Unknown or already-resolved incident." }, { status: 404 });
    }
    const incident = await getStatusIncident(incidentId);
    const service = (await listStatusServices()).find((s) => s.id === incident?.service_id);
    // Last open incident resolved → the internal system reads healthy again.
    if (service?.provider === "manual") {
      const { setServiceStatus, listStatusIncidents } = await import("@/lib/db");
      const stillOpen = (await listStatusIncidents()).some(
        (i) => i.state === "open" && i.service_id === service.id
      );
      if (!stillOpen) {
        await setServiceStatus(service.id, { status: "operational", detail: "", url: "" });
      }
    }
    await audit({
      actor: actorFrom(user),
      action: "status.incident_resolved",
      details: { title: resolved.title },
      ip: ipFrom(req),
    });
    void alertManualIncident({
      serviceName: service?.name ?? "Service",
      title: resolved.title,
      severity: "outage",
      resolved: true,
      origin: requestOrigin(req),
    }).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
