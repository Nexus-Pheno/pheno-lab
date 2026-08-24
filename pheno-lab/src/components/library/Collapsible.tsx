"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "@/components/ui";

// Shared collapsible library section: a one-line header that expands.
export function LibrarySection({
  title,
  subtitle,
  count,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  count?: number;
  icon?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2.5 text-left">
        <h2 className="text-[15px] font-bold flex items-center gap-2">
          {icon && <Icon name={icon} size={16} className="text-brand-deep" />}
          {title}
        </h2>
        {count !== undefined && <span className="mono text-[11px] text-muted">{count}</span>}
        {subtitle && <span className="text-[11px] text-muted hidden sm:inline flex-1 truncate">{subtitle}</span>}
        <span className="flex-1 sm:hidden" />
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={15} className="text-muted shrink-0" />
      </button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}
