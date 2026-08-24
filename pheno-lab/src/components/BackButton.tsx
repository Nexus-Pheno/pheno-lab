"use client";

import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui";

export function BackButton() {
  const router = useRouter();
  return (
    <button
      onClick={() => router.back()}
      title="Back"
      className="p-1.5 rounded-[4px] text-charcoal hover:bg-subtle"
    >
      <Icon name="ArrowLeft" size={16} />
    </button>
  );
}
