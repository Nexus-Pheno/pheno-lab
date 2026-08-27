"use client";

import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Pointer-based drag and drop that works with both mouse and touch (HTML5
 * drag events never fire on touch screens). Attach the returned starter to a
 * dedicated handle's onPointerDown; elements carrying `attr` are drop targets.
 * The handle should also set `touch-action: none` so dragging doesn't scroll.
 */
export function usePointerDrag({
  attr,
  onHover,
  onDrop,
  onTap,
  onDragStart,
  onDragEnd,
  onPoint,
  scrollEls,
}: {
  attr: string;
  onHover: (target: string | null) => void;
  onDrop: (dragged: string, target: string) => void;
  /** A press released without real movement — lets one handle both select and drag. */
  onTap?: (dragged: string) => void;
  /** Movement crossed the tap threshold: the element is really being dragged. */
  onDragStart?: (dragged: string) => void;
  /** The gesture ended, dropped or not. */
  onDragEnd?: (dragged: string) => void;
  /** Streams pointer coordinates during a real drag (for a ghost element). */
  onPoint?: (x: number, y: number) => void;
  /** Containers to auto-scroll while dragging near the viewport edges. */
  scrollEls?: () => (HTMLElement | null)[];
}) {
  const cbs = useRef({ onHover, onDrop, onTap, onDragStart, onDragEnd, onPoint, scrollEls });
  useEffect(() => {
    cbs.current = { onHover, onDrop, onTap, onDragStart, onDragEnd, onPoint, scrollEls };
  }, [onDrop, onHover, onTap, onDragStart, onDragEnd, onPoint, scrollEls]);

  const startDrag = useCallback(
    (dragged: string) => (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        // Capture is a nicety — window listeners below do the real work.
      }
      let last: string | null = null;
      let edgeX = 0;
      let edgeY = 0;
      const startX = e.clientX;
      const startY = e.clientY;
      let maxDistance = 0;

      const EDGE = 56;
      const SPEED = 14;
      const containers = cbs.current.scrollEls?.().filter(Boolean) ?? [];
      const tick = window.setInterval(() => {
        if (!edgeX && !edgeY) return;
        for (const el of containers) {
          if (edgeX) el!.scrollLeft += edgeX * SPEED;
          if (edgeY) el!.scrollTop += edgeY * SPEED;
        }
      }, 16);

      const move = (ev: PointerEvent) => {
        const wasTap = maxDistance < 8;
        maxDistance = Math.max(
          maxDistance,
          Math.hypot(ev.clientX - startX, ev.clientY - startY),
        );
        if (wasTap && maxDistance >= 8) cbs.current.onDragStart?.(dragged);
        if (maxDistance >= 8) cbs.current.onPoint?.(ev.clientX, ev.clientY);
        edgeX =
          ev.clientX > window.innerWidth - EDGE
            ? 1
            : ev.clientX < EDGE
              ? -1
              : 0;
        edgeY =
          ev.clientY > window.innerHeight - EDGE
            ? 1
            : ev.clientY < EDGE
              ? -1
              : 0;
        const hit = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest(`[${attr}]`);
        const v = hit?.getAttribute(attr) ?? null;
        const target = v && v !== dragged ? v : null;
        if (target !== last) {
          last = target;
          cbs.current.onHover(target);
        }
      };
      const finish = (drop: boolean) => {
        window.clearInterval(tick);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        cbs.current.onHover(null);
        cbs.current.onDragEnd?.(dragged);
        if (drop && maxDistance < 8 && cbs.current.onTap) {
          cbs.current.onTap(dragged);
        } else if (drop && last) {
          cbs.current.onDrop(dragged, last);
        }
      };
      const up = () => finish(true);
      const cancel = () => finish(false);

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
    [attr],
  );

  return startDrag;
}
