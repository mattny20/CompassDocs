"use client";

// Lazy page tree under a space in the sidebar (nested pages, admin-gated).
// Fetched on first expand; each node with children gets its own chevron.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, LoaderCircle } from "lucide-react";

interface TreeNode {
  id: number;
  title: string;
  status: string;
  children: TreeNode[];
}

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const path = usePathname();
  const active = path === `/doc/${node.id}`;
  const [open, setOpen] = useState(false);
  return (
    <li>
      <span
        className={`flex items-center gap-1 rounded-md py-1 pr-2 ${
          active ? "bg-compass-50 text-compass-700" : "text-slate-500 hover:bg-slate-100"
        }`}
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        {node.children.length > 0 ? (
          <button
            onClick={() => setOpen((o) => !o)}
            title={open ? "Collapse" : "Expand"}
            aria-label={`${open ? "Collapse" : "Expand"} ${node.title}`}
            className="rounded p-0.5 text-slate-400 hover:text-slate-600"
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden />
        )}
        <Link href={`/doc/${node.id}`} className="min-w-0 flex-1 truncate text-[13px]" title={node.title}>
          {node.title}
        </Link>
        {node.status === "draft" && (
          <span className="shrink-0 rounded-full bg-slate-100 px-1 text-[9px] font-medium uppercase text-slate-500">
            D
          </span>
        )}
      </span>
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <TreeRow key={c.id} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function SidebarSpaceTree({ spaceId }: { spaceId: number }) {
  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/spaces/${spaceId}/tree`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (!cancelled) setTree(d.tree);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  if (failed) return null;
  if (tree === null) {
    return (
      <p className="flex items-center gap-1.5 py-1 pl-6 text-xs text-slate-400">
        <LoaderCircle className="h-3 w-3 animate-spin" /> Loading…
      </p>
    );
  }
  if (tree.length === 0) {
    return <p className="py-1 pl-6 text-xs text-slate-400">No pages yet.</p>;
  }
  return (
    <ul className="mb-1">
      {tree.map((n) => (
        <TreeRow key={n.id} node={n} depth={1} />
      ))}
    </ul>
  );
}
