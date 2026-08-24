"use client";

import { icons, type LucideProps } from "lucide-react";

export function Icon({ name, ...props }: { name: string } & LucideProps) {
  const C = icons[name as keyof typeof icons] ?? icons.Wrench;
  return <C strokeWidth={1.75} {...props} />;
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-bold uppercase text-muted mb-1">{children}</div>;
}

const CONTROLLED_ENV = /glovebox|vacuum|clean room|dry/i;

export function EnvBadge({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  const cls = CONTROLLED_ENV.test(name)
    ? "bg-[#EAF3F4] text-data-cyan border-[#C8E0E2]"
    : "bg-subtle text-muted border-line";
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] border ${cls}`}>
      {name}
    </span>
  );
}

export const inputCls =
  "w-full border border-line rounded-[4px] px-2.5 py-1.5 text-[13px] bg-surface disabled:bg-subtle disabled:text-muted";
export const selectCls = inputCls + " appearance-none";
