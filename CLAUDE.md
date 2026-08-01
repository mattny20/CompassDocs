# CompassDocs — working notes for Claude

- **UI work must follow [STYLEGUIDE.md](STYLEGUIDE.md)** — page skeleton
  (PageContainer + icon title + subtitle), tooltips via `data-tt` (never
  native `title` on controls; icon-only controls also need `aria-label`),
  empty-state tiers, chip/button/print/dark-mode rules, lucide-only icons.
  If a new pattern is needed, add it to the guide in the same PR.
- **Releases follow [RELEASING.md](RELEASING.md)** — version bump in both
  package files, PR titled "X.Y.Z: summary", squash-merge, docker-publish,
  release.yml, then the enterprise image build (which also mirrors to the
  cloud fleet's registry).
- Accent/theming: `--compass-*`/`--slate-*` CSS vars are raw "R G B"
  triplets — always `rgb(var(--…))` in hand-written CSS; a bare var fails
  silently.
- Enterprise (`ee/`) feature-list changes ship from the **compassdocs-ee
  overlay repo**, not core — the image build overlays that repo's `ee/`
  over core's.
