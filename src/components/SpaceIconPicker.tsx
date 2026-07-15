"use client";

// Space icon picker: a curated, searchable emoji catalog grouped by theme.
// Emoji are the icon set on purpose — they're colorful, render everywhere
// with zero assets, and read instantly at sidebar size. Search matches the
// keywords next to each emoji; any emoji can still be typed by hand.

import { useMemo, useState } from "react";

type IconEntry = { e: string; k: string };
type Category = { label: string; icons: IconEntry[] };

const CATALOG: Category[] = [
  {
    label: "General & docs",
    icons: [
      { e: "📁", k: "folder files" },
      { e: "🗂️", k: "dividers organize archive" },
      { e: "📘", k: "book manual guide blue" },
      { e: "📗", k: "book green handbook" },
      { e: "📙", k: "book orange" },
      { e: "📕", k: "book red" },
      { e: "📚", k: "books library knowledge" },
      { e: "📝", k: "note memo writing" },
      { e: "🗒️", k: "notepad notes" },
      { e: "📋", k: "clipboard checklist process" },
      { e: "🧭", k: "compass navigate onboarding" },
      { e: "⭐", k: "star favorite important" },
      { e: "📌", k: "pin pinned" },
      { e: "🔖", k: "bookmark reference" },
      { e: "🗃️", k: "card box records archive" },
    ],
  },
  {
    label: "Tech & engineering",
    icons: [
      { e: "⚙️", k: "gear settings config engineering" },
      { e: "🔧", k: "wrench fix maintenance" },
      { e: "🛠️", k: "tools build devops" },
      { e: "💻", k: "laptop code development" },
      { e: "🖥️", k: "desktop workstation it" },
      { e: "🧑‍💻", k: "developer engineer coder" },
      { e: "🤖", k: "robot automation ai bot" },
      { e: "☁️", k: "cloud infrastructure aws azure" },
      { e: "🌐", k: "globe network web internet" },
      { e: "💾", k: "save disk data storage" },
      { e: "🗄️", k: "server database storage" },
      { e: "🔌", k: "plug integration api" },
      { e: "📡", k: "antenna network signal" },
      { e: "🧪", k: "test lab experiment qa" },
      { e: "🐛", k: "bug issue defect" },
      { e: "🚀", k: "rocket launch deploy release product" },
      { e: "📦", k: "package release shipping" },
      { e: "🔬", k: "microscope research analysis" },
    ],
  },
  {
    label: "Business & sales",
    icons: [
      { e: "📊", k: "chart analytics data reporting" },
      { e: "📈", k: "graph growth metrics" },
      { e: "📉", k: "decline finance" },
      { e: "💼", k: "briefcase business corporate" },
      { e: "🏢", k: "office building company" },
      { e: "💰", k: "money finance budget" },
      { e: "💳", k: "card payment billing" },
      { e: "🧾", k: "receipt invoice accounting" },
      { e: "🤝", k: "handshake partner deal sales" },
      { e: "🎯", k: "target goal okr strategy" },
      { e: "🏆", k: "trophy win success awards" },
      { e: "📣", k: "megaphone marketing announce" },
      { e: "🛒", k: "cart commerce store" },
      { e: "🏷️", k: "tag label pricing" },
    ],
  },
  {
    label: "People & culture",
    icons: [
      { e: "👥", k: "people team hr users" },
      { e: "🌱", k: "seedling growth onboarding people ops" },
      { e: "🎓", k: "graduation training learning education" },
      { e: "🧠", k: "brain knowledge ideas" },
      { e: "❤️", k: "heart culture values wellbeing" },
      { e: "🎉", k: "party celebration events" },
      { e: "☕", k: "coffee social breakroom" },
      { e: "💬", k: "chat communication support" },
      { e: "📞", k: "phone contact call center" },
      { e: "✉️", k: "mail email communication" },
      { e: "📅", k: "calendar schedule planning" },
      { e: "🗣️", k: "speaking presentations" },
    ],
  },
  {
    label: "Security & operations",
    icons: [
      { e: "🛡️", k: "shield security protection compliance" },
      { e: "🔒", k: "lock private secure" },
      { e: "🔑", k: "key access credentials" },
      { e: "🚨", k: "alarm incident emergency" },
      { e: "🧯", k: "extinguisher incident response fire" },
      { e: "⚠️", k: "warning caution risk" },
      { e: "🚧", k: "construction wip maintenance" },
      { e: "🧰", k: "toolbox runbook ops" },
      { e: "💡", k: "idea lightbulb tips howto" },
      { e: "⚡", k: "lightning power fast energy" },
      { e: "♻️", k: "recycle sustainability process" },
      { e: "🩺", k: "health medical checkup" },
    ],
  },
  {
    label: "Places & misc",
    icons: [
      { e: "🏠", k: "home house remote" },
      { e: "🏭", k: "factory manufacturing plant" },
      { e: "🏗️", k: "crane construction projects" },
      { e: "🚚", k: "truck logistics delivery shipping" },
      { e: "✈️", k: "plane travel trips" },
      { e: "🌍", k: "earth world international" },
      { e: "🗺️", k: "map roadmap plans" },
      { e: "🎨", k: "palette design creative brand" },
      { e: "🎬", k: "clapper video media" },
      { e: "📷", k: "camera photos assets" },
      { e: "🎧", k: "headphones support helpdesk music" },
      { e: "🧩", k: "puzzle integration piece" },
      { e: "🦉", k: "owl wisdom knowledge" },
      { e: "🐙", k: "octopus github multitask" },
    ],
  },
];

export function SpaceIconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (icon: string) => void;
}) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CATALOG;
    return CATALOG.map((c) => ({
      label: c.label,
      icons: c.icons.filter((i) => i.k.includes(q) || i.e === q),
    })).filter((c) => c.icons.length > 0);
  }, [query]);

  return (
    <div className="rounded-lg border border-slate-200 bg-surface">
      <div className="flex items-center gap-2 border-b border-slate-100 p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search icons… (rocket, security, training)"
          className="flex-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-compass-400"
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.slice(0, 8))}
          className="h-9 w-14 rounded-md border border-slate-200 px-2 text-center text-lg outline-none focus:border-compass-400"
          aria-label="Custom emoji"
          title="Type or paste any emoji"
        />
      </div>
      <div className="max-h-52 overflow-y-auto p-2">
        {results.length === 0 ? (
          <p className="px-1 py-3 text-center text-sm text-slate-400">
            No match — paste any emoji into the box above.
          </p>
        ) : (
          results.map((c) => (
            <div key={c.label} className="mb-1.5">
              <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                {c.label}
              </div>
              <div className="flex flex-wrap gap-0.5">
                {c.icons.map((i) => (
                  <button
                    key={i.e}
                    type="button"
                    onClick={() => onChange(i.e)}
                    title={i.k}
                    className={`flex h-9 w-9 items-center justify-center rounded-md text-xl transition ${
                      value === i.e ? "bg-compass-100 ring-2 ring-compass-400" : "hover:bg-slate-100"
                    }`}
                  >
                    {i.e}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
