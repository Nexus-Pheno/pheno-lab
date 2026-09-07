"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import {
  newQrDetector,
  qrScanSupported,
  sampleIdFromScan,
} from "@/lib/qr-scan";

const emptySubscribe = () => () => {};

/**
 * Scan a printed sample label to jump straight into capture with that sample
 * selected. Renders only where BarcodeDetector + camera exist (Chrome/Edge on
 * Android — the lab tablets); elsewhere the printed QR still works via the
 * device's own camera app.
 */
export function ScanButton({ variant }: { variant: "tile" | "compact" }) {
  const t = useT();
  const router = useRouter();
  // Hydration-safe capability check: false on the server, real answer after.
  const supported = useSyncExternalStore(
    emptySubscribe,
    qrScanSupported,
    () => false,
  );
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const video = videoRef.current;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled || !video) return;
        video.srcObject = stream;
        await video.play();
        const detector = newQrDetector();
        let navigating = false;
        timer = setInterval(async () => {
          if (navigating || !video.videoWidth) return;
          try {
            const codes = await detector.detect(video);
            const id = codes
              .map((code) => sampleIdFromScan(code.rawValue))
              .find(Boolean);
            if (id) {
              navigating = true;
              router.push(`/scan/${id}`);
            }
          } catch {
            // Camera still warming up or tab hidden — keep trying.
          }
        }, 300);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
    };
  }, [open, router]);

  if (!supported) return null;

  return (
    <>
      {variant === "tile" ? (
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setOpen(true);
          }}
          className="w-full bg-surface border border-line rounded-[8px] p-3 flex items-center gap-2.5 text-[13px] font-bold text-charcoal active:bg-subtle"
        >
          <Icon name="ScanLine" size={18} className="text-brand-deep" />
          {t("scan.button")}
          <Icon name="ChevronRight" size={16} className="ml-auto text-muted" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setOpen(true);
          }}
          className="text-[11px] font-semibold text-charcoal shrink-0 py-1 px-1 flex items-center gap-1"
        >
          <Icon name="ScanLine" size={13} />
          {t("scan.button")}
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          {failed ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
              <p className="text-white/90 text-sm text-center">
                {t("scan.fail")}
              </p>
            </div>
          ) : (
            <div className="relative flex-1 min-h-0">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                ref={videoRef}
                playsInline
                muted
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-56 h-56 border-2 border-white/80 rounded-[12px]" />
              </div>
              <p className="absolute bottom-24 inset-x-0 text-center text-white/90 text-[13px] font-semibold px-6">
                {t("scan.hint")}
              </p>
            </div>
          )}
          <div className="shrink-0 p-4 pb-6 bg-black">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-full h-11 rounded-[8px] border border-white/40 text-white text-sm font-semibold"
            >
              {t("scan.cancel")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
