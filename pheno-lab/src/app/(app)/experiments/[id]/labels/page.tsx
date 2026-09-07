import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { requireSession } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { Icon } from "@/components/ui";
import { PrintButton } from "@/components/report/PrintButton";
import {
  getExperimentCode,
  getLabelSheetData,
} from "@/modules/experiments/query";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const experiment = await getExperimentCode(session, id);
  return { title: experiment ? `${experiment.code} labels` : "Labels" };
}

// A4 label stock, 21-up (70 × 42.3 mm) — Michael's chosen format. The grid
// fills the page edge to edge, so the print dialog must be set to 100% scale
// with no margins; the toolbar reminds the technician.
const COLS = 3;
const PER_SHEET = 21;

const chunk = <T,>(rows: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

export default async function LabelsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const t = await getT();
  const experiment = await getLabelSheetData(session, id);
  if (!experiment) notFound();

  // The QR encodes an absolute /scan URL so a phone's native camera app can
  // open it too — derived from the request host to avoid hardcoding a domain.
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const proto =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.")
      ? "http"
      : "https");

  const labels = await Promise.all(
    experiment.samples.map(async (sample) => ({
      ...sample,
      qrSvg: await QRCode.toString(`${proto}://${host}/scan/${sample.id}`, {
        type: "svg",
        margin: 0,
        errorCorrectionLevel: "Q",
      }),
    })),
  );

  return (
    <main className="min-h-full bg-subtle print:bg-white">
      <style>{`
        @page { size: A4; margin: 0; }
        .label-sheet { width: 210mm; height: 296.9mm; }
        .label-cell { width: 70mm; height: 42.3mm; outline: 0.2mm dashed #d8d8d8; }
        .label-qr svg { width: 100%; height: 100%; display: block; }
        @media print {
          .label-cell { outline: none; }
          .label-sheet { break-after: page; }
        }
      `}</style>

      <div className="print:hidden max-w-[210mm] mx-auto px-4 pt-4 flex items-center gap-3 flex-wrap">
        <Link
          href={`/experiments/${experiment.id}`}
          className="h-8 text-xs font-semibold text-charcoal border border-line rounded-[4px] px-3 hover:bg-surface flex items-center gap-1.5 bg-surface"
        >
          <Icon name="ArrowLeft" size={13} />
          {experiment.code}
        </Link>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-charcoal">{t("labels.title")}</p>
          <p className="text-[11px] text-muted">{t("labels.hint")}</p>
        </div>
        <PrintButton title={`${experiment.code}-labels`} />
      </div>

      {labels.length === 0 ? (
        <p className="text-center text-muted text-[13px] py-16">
          {t("labels.empty")}
        </p>
      ) : (
        <div className="flex flex-col items-center gap-6 py-6 print:gap-0 print:py-0">
          {chunk(labels, PER_SHEET).map((sheet, sheetIndex) => (
            <div
              key={sheetIndex}
              className="label-sheet bg-white shadow-sm print:shadow-none grid"
              style={{ gridTemplateColumns: `repeat(${COLS}, 70mm)` }}
            >
              {sheet.map((label) => (
                <div
                  key={label.id}
                  className="label-cell flex items-center gap-[3mm] overflow-hidden"
                  style={{ padding: "4mm 4mm" }}
                >
                  <div
                    className="label-qr shrink-0"
                    style={{ width: "30mm", height: "30mm" }}
                    dangerouslySetInnerHTML={{ __html: label.qrSvg }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="mono font-bold text-black leading-tight break-all text-[10pt]">
                      {experiment.code}-{label.code}
                    </p>
                    {label.simCode && (
                      <p className="mono font-bold text-black text-[15pt] leading-tight mt-[1mm]">
                        {label.simCode}
                      </p>
                    )}
                    <div className="mt-[1mm] flex items-start gap-[1.5mm] text-[7pt]">
                      {label.variationGroup && (
                        <span className="mono font-bold text-black shrink-0">
                          [{label.variationGroup}]
                        </span>
                      )}
                      <span className="text-neutral-600 leading-snug line-clamp-2">
                        {experiment.title}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
