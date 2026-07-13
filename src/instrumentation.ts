// Runs once when the server process starts. We use it to drive scheduled
// backups from within the app (no external cron needed). The check is cheap and
// advisory-lock guarded, so it's safe to run on an interval and with multiple
// instances.
export async function register() {
  // Only in the Node.js server runtime — not during build or on the edge.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly

  const tick = async () => {
    try {
      const { runScheduledBackupIfDue } = await import("./lib/backup");
      await runScheduledBackupIfDue();
    } catch (e) {
      console.error("[backup] scheduler error:", e);
    }
  };

  // First check shortly after boot, then hourly.
  setTimeout(tick, 60_000);
  setInterval(tick, CHECK_INTERVAL_MS);
}
