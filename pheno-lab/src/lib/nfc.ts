// Minimal Web NFC typings + helpers. Chrome/Edge on Android only; everything
// degrades gracefully elsewhere. Shared by the badge bind flow (profile) and
// the tap-to-sign-in button (shared-tablet login screen).

export type NdefRecordLike = {
  recordType: string;
  data?: DataView;
  encoding?: string;
};

export type NdefReadingEvent = {
  serialNumber: string;
  message: { records: NdefRecordLike[] };
};

type NdefReaderLike = {
  scan: (options?: { signal?: AbortSignal }) => Promise<void>;
  write: (
    message: { records: { recordType: string; data: string }[] },
    options?: { signal?: AbortSignal },
  ) => Promise<void>;
  addEventListener: (
    type: "reading" | "readingerror",
    listener: (event: NdefReadingEvent) => void,
  ) => void;
};

export function nfcSupported(): boolean {
  return typeof window !== "undefined" && "NDEFReader" in window;
}

export function newNdefReader(): NdefReaderLike {
  return new (
    window as unknown as { NDEFReader: new () => NdefReaderLike }
  ).NDEFReader();
}

/** "04:1D:C6:8A:DA:1B:90" → "041dc68ada1b90" */
export function canonicalBadgeUid(serialNumber: string): string {
  return serialNumber.toLowerCase().replace(/[:\s-]/g, "");
}

const TOKEN_PREFIX = "pheno:";

/** The pheno token from a tag's text records, if the bind flow wrote one. */
export function tokenFromRecords(records: NdefRecordLike[]): string {
  for (const record of records) {
    if (record.recordType !== "text" || !record.data) continue;
    try {
      const text = new TextDecoder(record.encoding ?? "utf-8").decode(
        record.data,
      );
      if (text.startsWith(TOKEN_PREFIX)) return text.slice(TOKEN_PREFIX.length);
    } catch {
      // Unreadable record — ignore and keep looking.
    }
  }
  return "";
}

export function makeBadgeToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const badgeTokenRecord = (token: string) => ({
  recordType: "text",
  data: TOKEN_PREFIX + token,
});
