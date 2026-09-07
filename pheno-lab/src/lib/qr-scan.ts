// Minimal BarcodeDetector typings + helpers for scanning sample-label QRs.
// Chrome/Edge on Android (the lab tablets) have it natively; everywhere else
// the scan button simply does not render — the printed QR still works through
// the phone's own camera app, which opens the /scan URL directly.

type DetectedBarcode = { rawValue: string };

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
};

export function qrScanSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "BarcodeDetector" in window &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export function newQrDetector(): BarcodeDetectorLike {
  return new (
    window as unknown as {
      BarcodeDetector: new (options: {
        formats: string[];
      }) => BarcodeDetectorLike;
    }
  ).BarcodeDetector({ formats: ["qr_code"] });
}

/** The sample id from a scanned label URL, or null for foreign QR codes. */
export function sampleIdFromScan(rawValue: string): string | null {
  const match = rawValue.match(/\/scan\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}
