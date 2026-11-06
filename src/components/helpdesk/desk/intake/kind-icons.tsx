// The lucide icon for each integration kind (agent P). Server-safe.

import { ChartLine, Cloud, Dog, Flame, Mail, Siren, SquareTerminal, Webhook, type LucideIcon } from "lucide-react";
import type { HdIntegrationKind } from "@/lib/helpdesk/intake/shared";

export const KIND_ICON: Record<HdIntegrationKind, LucideIcon> = {
  prometheus: Flame,
  grafana: ChartLine,
  datadog: Dog,
  azure_monitor: Cloud,
  pagerduty_like: Siren,
  webhook_generic: Webhook,
  api: SquareTerminal,
  email: Mail,
};

export const KIND_HINT: Record<HdIntegrationKind, string> = {
  prometheus: "Alertmanager's webhook receiver",
  grafana: "A webhook contact point",
  datadog: "A webhook from monitors",
  azure_monitor: "An action group webhook, common alert schema",
  pagerduty_like: "Tools that send PagerDuty Events API v2",
  webhook_generic: "Any tool that can POST JSON",
  api: "Scripts, bots and agents opening tickets",
  email: "Monitoring that can only send mail",
};
