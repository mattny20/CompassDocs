// Server half of the command palette: resolves what this user is allowed to
// see once, then hands the client a plain allow-list. Entitlements and space
// grants aren't on the session, so this evaluation can only happen here.
//
// Mounting note: this renders as a direct child of the app shell's root flex
// div, which sets no z-index, transform, filter, or opacity — so it creates no
// stacking context and a position:fixed overlay inside it is not clamped. That
// is why no portal is needed. If a transform ever lands on the shell, the
// overlay will start clipping and the fix is a portal, not a bigger z-index.

import { allowedCommandIds, type NavCapabilities } from "@/lib/nav-capabilities";
import { CommandPaletteClient } from "./CommandPaletteClient";
import type { SpaceLite } from "./sources";

export function CommandPalette({
  userId,
  caps,
  spaces,
}: {
  userId: number;
  caps: NavCapabilities;
  spaces: SpaceLite[];
}) {
  return (
    <CommandPaletteClient
      userId={userId}
      caps={caps as unknown as Record<string, boolean>}
      commandIds={allowedCommandIds(caps)}
      spaces={spaces}
    />
  );
}
