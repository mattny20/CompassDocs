// 1.19.1 carry-over: a settings page may carry its own permission
// (lib/settings-sections pages[].permission). Settings → Notifications →
// Policies opens with notification.policy_read; its holders see the
// Notifications entry in the rail (landing on Policies), its tab, and its
// search row, without the section's integration.webhook_read; holders of
// only the section's permission no longer see a tab that would send them
// home. Pure: the reachability list is what reachableSettingsSections returns.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/settings-page-permissions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_SECTIONS,
  canOpenPage,
  canOpenSection,
  pagePermission,
  sectionLanding,
  sectionPermissions,
  settingsSection,
} from "../src/lib/settings-sections";

const notifications = settingsSection("/admin/notifications")!;
const policies = notifications.pages!.find((p) => p.href === "/admin/notifications/policies")!;
const webhooks = notifications.pages!.find((p) => p.href === "/admin/notifications")!;

test("Policies opens with notification.policy_read; the other pages with the section's permission", () => {
  assert.equal(pagePermission(notifications, policies), "notification.policy_read");
  assert.equal(pagePermission(notifications, webhooks), "integration.webhook_read");
  assert.deepEqual(sectionPermissions(notifications), ["integration.webhook_read", "notification.policy_read"]);
});

test("a policy_read-only holder reaches the section through Policies", () => {
  const reach = ["/admin/notifications/policies"];
  assert.equal(canOpenSection(reach, notifications), true);
  assert.equal(sectionLanding(reach, notifications), "/admin/notifications/policies");
  assert.equal(canOpenPage(reach, notifications, policies), true);
  assert.equal(canOpenPage(reach, notifications, webhooks), false);
});

test("a webhook_read-only holder sees the section's pages but not Policies", () => {
  const reach = ["/admin/notifications"];
  assert.equal(sectionLanding(reach, notifications), "/admin/notifications");
  assert.equal(canOpenPage(reach, notifications, webhooks), true);
  assert.equal(canOpenPage(reach, notifications, policies), false);
});

test("a section without page permissions is unchanged", () => {
  const dir = settingsSection("/admin/directory")!;
  assert.deepEqual(sectionPermissions(dir), [dir.permission]);
  assert.equal(canOpenSection(["/admin/directory"], dir), true);
  assert.equal(canOpenSection([], dir), false);
  for (const p of dir.pages!) assert.equal(canOpenPage(["/admin/directory"], dir, p), true);
});

test("every page permission is a real permission key", async () => {
  const { PERMISSIONS } = await import("../src/lib/permissions");
  const keys = new Set<string>(PERMISSIONS.map((p) => p.key));
  for (const s of SETTINGS_SECTIONS) for (const p of s.pages ?? []) if (p.permission) assert.ok(keys.has(p.permission), p.permission);
});
