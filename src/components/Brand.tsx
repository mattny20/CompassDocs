// Renders the workspace mark + name from the configured company_name / logo_url.
// Falls back to the default compass emoji when no logo is set. Server-safe
// (no client hooks) so it can be used directly in server components.

export function Brand({
  name,
  logoUrl,
  size = "md",
  layout = "row",
}: {
  name: string;
  logoUrl?: string;
  size?: "md" | "lg";
  layout?: "row" | "col";
}) {
  const box = size === "lg" ? "h-12 w-12 rounded-xl text-2xl" : "h-8 w-8 rounded-lg text-lg";
  const nameCls =
    size === "lg"
      ? "mt-3 text-2xl font-bold text-slate-900"
      : "text-lg font-bold tracking-tight text-slate-900";

  const mark = logoUrl ? (
    // A customer-supplied logo (white-label): keep it on a light chip since we
    // can't know its shape/colours.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logoUrl}
      alt={name}
      className={`${box} object-contain bg-white shadow-sm ring-1 ring-slate-200`}
    />
  ) : (
    // The CompassDocs mark — a transparent PNG that sits on any background.
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/mark.png" alt={name} className={`${box} object-contain`} />
  );

  return (
    <span className={layout === "col" ? "flex flex-col items-center" : "flex items-center gap-2"}>
      {mark}
      <span className={nameCls}>{name}</span>
    </span>
  );
}
