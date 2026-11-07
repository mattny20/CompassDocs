// Helpdesk 1.19.4: Microsoft Intune as an asset source (lib/helpdesk/assets,
// lib/helpdesk/assets/intune). Dependency-free so lib/db's SCHEMA string can
// append it; additive and idempotent; after HD_ASSETS_SCHEMA (it alters
// hd_assets).
//
//   hd_assets.assigned_upn  a second address the device's person is known by
//                           (Intune's user principal name, lower-cased; ""
//                           for Snipe-IT rows). A confirmed account address
//                           matches either it or assigned_email.

export const HD_INTUNE_SCHEMA = `
ALTER TABLE hd_assets ADD COLUMN IF NOT EXISTS assigned_upn text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_hd_assets_upn ON hd_assets (assigned_upn) WHERE assigned_upn <> '';
`;
