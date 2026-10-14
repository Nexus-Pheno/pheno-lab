"use client";

import { useRef, useState, type ReactNode } from "react";

export function HorizontalScroll({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  const drag = useRef<{
    pointerId: number;
    startX: number;
    scrollLeft: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      data-horizontal-scroll
      className={
        "min-w-0 max-w-full overflow-x-auto rounded-[3px] focus-visible:outline-2 focus-visible:outline-brand-deep " +
        (dragging ? "cursor-grabbing select-none" : "cursor-grab")
      }
      onPointerDown={(event) => {
        const container = event.currentTarget;
        if (
          event.pointerType !== "mouse" ||
          event.button !== 0 ||
          event.shiftKey ||
          container.scrollWidth <= container.clientWidth ||
          (event.target as Element).closest(
            "a, button, input, select, textarea, [contenteditable=true]",
          ) ||
          event.clientY >=
            container.getBoundingClientRect().top + container.clientHeight
        ) {
          return;
        }
        event.preventDefault();
        container.focus({ preventScroll: true });
        container.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          scrollLeft: container.scrollLeft,
        };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        event.currentTarget.scrollLeft =
          drag.current.scrollLeft - (event.clientX - drag.current.startX);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        drag.current = null;
        setDragging(false);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
    >
      {children}
    </div>
  );
}
