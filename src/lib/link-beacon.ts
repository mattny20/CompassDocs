// Records a click on a curated link (1.17.0) without touching the link
// itself: the <a> keeps its real href, and this sends a same-origin POST to
// /api/links/{id}/click on the way out. sendBeacon survives the page
// unloading (a link that opens in this tab); fetch with keepalive is the
// fallback. Never throws and never delays the navigation: a lost click is
// only a lost count.

export function trackLinkClick(linkId: number): void {
  if (!Number.isInteger(linkId) || linkId <= 0) return;
  const url = `/api/links/${linkId}/click`;
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon(url)) return;
    }
  } catch {
    /* fall through to fetch */
  }
  try {
    void fetch(url, { method: "POST", keepalive: true, credentials: "same-origin" }).catch(() => {});
  } catch {
    /* a lost click is only a lost count */
  }
}
