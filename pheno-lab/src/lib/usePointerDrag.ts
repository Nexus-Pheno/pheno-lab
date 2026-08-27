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
      // No preventDefault here: a quick swipe must stay a native scroll.
      let armed = false;
      let last: string | null = null;
      let edgeX = 0;
      let edgeY = 0;
      const startX = e.clientX;
      const startY = e.clientY;
      let maxDistance = 0;
      const el = e.currentTarget as HTMLElement;

      const EDGE = 56;
      const SPEED = 14;
      const HOLD_MS = 220;
      const SCROLL_SLOP = 10;
      const containers = cbs.current.scrollEls?.().filter(Boolean) ?? [];
      const tick = window.setInterval(() => {
        if (!armed || (!edgeX && !edgeY)) return;
        for (const c of containers) {
          if (edgeX) c!.scrollLeft += edgeX * SPEED;
          if (edgeY) c!.scrollTop += edgeY * SPEED;
        }
      }, 16);

      // Once armed, swallow touch scrolling so the drag owns the gesture.
      const blockScroll = (ev: TouchEvent) => {
        if (armed) ev.preventDefault();
      };

      const hold = window.setTimeout(() => {
        armed = true;
        try {
          el.setPointerCapture?.(e.pointerId);
        } catch {
          // Capture is a nicety — window listeners do the real work.
        }
        document.addEventListener("touchmove", blockScroll, { passive: false });
        cbs.current.onDragStart?.(dragged);
      }, HOLD_MS);

      const move = (ev: PointerEvent) => {
        maxDistance = Math.max(
          maxDistance,
          Math.hypot(ev.clientX - startX, ev.clientY - startY),
        );
        if (!armed) {
          // Real movement before the hold elapsed: this is a scroll, not a
          // pickup. Bow out entirely and let the browser have the gesture.
          if (maxDistance > SCROLL_SLOP) finish(false);
          return;
        }
        cbs.current.onPoint?.(ev.clientX, ev.clientY);
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
        window.clearTimeout(hold);
        window.clearInterval(tick);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        document.removeEventListener("touchmove", blockScroll);
        cbs.current.onHover(null);
        if (armed) cbs.current.onDragEnd?.(dragged);
        if (drop && !armed && maxDistance < 8 && cbs.current.onTap) {
          cbs.current.onTap(dragged);
        } else if (drop && armed && last) {
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
