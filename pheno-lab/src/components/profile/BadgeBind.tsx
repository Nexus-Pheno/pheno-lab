"use client";

import { useState, useSyncExternalStore } from "react";
import { useT } from "@/lib/i18n/LanguageProvider";
import { Icon } from "@/components/ui";
import { bindBadge, unbindBadge } from "@/lib/actions/badges";
import {
  badgeTokenRecord,
  canonicalBadgeUid,
  makeBadgeToken,
  newNdefReader,
  nfcSupported,
} from "@/lib/nfc";

type Phase = "idle" | "scanning" | "writing" | "done" | "error";

const emptySubscribe = () => () => {};
const isTrue = () => true;
const isFalse = () => false;

/**
 * Bind the NFC work badge to this account. Read the chip's UID, write our
 * random token onto it (NTAG213 — 144 B user memory, plenty), and store both
 * server-side. Works only in Chrome/Edge on Android; elsewhere the section
 * explains instead of failing. Binding is done once, most naturally on the
 * shared tablet right after a normal password sign-in.
 */
export function BadgeBind({
  bound,
  boundAt,
}: {
  bound: boolean;
  boundAt: string | null;
}) {
  const t = useT();
  // Hydration-safe: "unknown" on the server render, real answer after mount.
  const mounted = useSyncExternalStore(emptySubscribe, isTrue, isFalse);
  const supported = useSyncExternalStore(emptySubscribe, nfcSupported, isFalse);
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState("");
  const [isBound, setIsBound] = useState(bound);

  const start = async () => {
    setPhase("scanning");
    setNote("");
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const reader = newNdefReader();
      const uid = await new Promise<string>((resolve, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error(t("nfc.timeout"))),
        );
        reader.addEventListener("reading", (event) =>
          resolve(canonicalBadgeUid(event.serialNumber)),
        );
        reader.scan({ signal: controller.signal }).catch(reject);
      });

      // Keep the card held: the token write rides the same tap.
      setPhase("writing");
      const token = makeBadgeToken();
      let wrote = true;
      try {
        await reader.write(
          { records: [badgeTokenRecord(token)] },
          { signal: controller.signal },
        );
      } catch {
        // Locked or write-protected tag — bind on UID alone.
        wrote = false;
      }
      clearTimeout(timeout);
      controller.abort();

      const result = await bindBadge(uid, wrote ? token : "");
      if (!result.ok) {
        setPhase("error");
        setNote(result.error ?? t("nfc.bindFailed"));
        return;
      }
      setIsBound(true);
      setPhase("done");
      setNote(wrote ? t("nfc.bindDone") : t("nfc.bindDoneUidOnly"));
    } catch (err) {
      setPhase("error");
      setNote((err as Error).message || t("nfc.bindFailed"));
    }
  };

  return (
    <section className="bg-surface border border-line rounded-[6px] p-4">
      <h2 className="text-[13px] font-bold mb-1 flex items-center gap-1.5">
        <Icon name="Nfc" size={14} className="text-charcoal" /> {t("nfc.title")}
      </h2>
      <p className="text-[11px] text-muted mb-3">{t("nfc.hint")}</p>

      {isBound && phase !== "done" && (
        <p className="text-[12px] text-brand-deep font-semibold mb-2 flex items-center gap-1.5">
          <Icon name="CheckCircle2" size={13} />
          {t("nfc.bound")}
          {boundAt && (
            <span className="text-muted font-normal">
              · {boundAt.slice(0, 10)}
            </span>
          )}
        </p>
      )}

      {mounted && !supported && (
        <p className="text-[12px] text-muted border border-dashed border-line rounded-[4px] px-2.5 py-2">
          {t("nfc.unsupported")}
        </p>
      )}

      {supported && (
        <div className="flex flex-wrap items-center gap-2">
          {phase === "scanning" || phase === "writing" ? (
            <span className="text-[12.5px] font-bold text-brand-deep flex items-center gap-1.5">
              <Icon name="Loader2" size={14} className="animate-spin" />
              {phase === "scanning" ? t("nfc.tapNow") : t("nfc.holdStill")}
            </span>
          ) : (
            <button
              onClick={start}
              className="h-9 px-3.5 text-[12.5px] font-bold text-brand-deep border border-brand/40 bg-brand-soft rounded-[4px] flex items-center gap-1.5"
            >
              <Icon name="Nfc" size={14} />
              {isBound ? t("nfc.rebind") : t("nfc.bind")}
            </button>
          )}
          {isBound && phase !== "scanning" && phase !== "writing" && (
            <button
              onClick={() => {
                void unbindBadge().then(() => {
                  setIsBound(false);
                  setPhase("idle");
                  setNote(t("nfc.unbound"));
                });
              }}
              className="h-9 px-3 text-[12px] font-semibold text-danger border border-danger/40 rounded-[4px]"
            >
              {t("nfc.unbind")}
            </button>
          )}
        </div>
      )}

      {note && (
        <p
          className={
            "text-[12px] mt-2 " +
            (phase === "error" ? "text-danger" : "text-brand-deep")
          }
        >
          {note}
        </p>
      )}
    </section>
  );
}
