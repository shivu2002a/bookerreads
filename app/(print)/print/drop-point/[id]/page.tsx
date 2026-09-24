import type { Metadata } from "next";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getDb } from "@/db/client";
import { getDropPoint } from "@/lib/admin/drop-points";
import { requireAdmin } from "@/lib/auth/current-member";
import { getPublicEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Drop point poster" };

const DAYS = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
] as const;

/**
 * Requirement 12.1: printable A4 poster with the venue QR. A print-styled page
 * (browser "Save as PDF") instead of a PDF library keeps dependencies small;
 * the QR is inline SVG. Admin-only because the QR embeds the venue secret.
 */
export default async function PosterPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const dp = await getDropPoint(getDb(), id);
  if (!dp) notFound();
  const url = `${getPublicEnv().NEXT_PUBLIC_APP_URL}/dp/${dp.id}?s=${dp.qrSecret}`;
  const svg = await QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 420,
  });

  return (
    <div className="poster">
      <style>{`
        @page { size: A4; margin: 18mm; }
        .poster { max-width: 174mm; margin: 0 auto; padding: 24px 16px; display: flex; flex-direction: column; gap: 18px; color: #111; }
        .poster h1 { font-size: 34px; margin: 0; letter-spacing: -0.01em; }
        .poster h2 { font-size: 20px; margin: 0; font-weight: 600; }
        .poster .qr { display: flex; justify-content: center; }
        .poster .qr svg { width: 110mm; height: 110mm; }
        .poster ol { font-size: 16px; line-height: 1.5; padding-left: 22px; margin: 0; }
        .poster .hours { font-size: 13px; color: #444; display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; text-align: center; }
        .poster .foot { font-size: 12px; color: #666; border-top: 1px solid #ddd; padding-top: 10px; }
        @media print { nav, header, footer, .no-print { display: none !important; } }
      `}</style>
      <p className="no-print" style={{ fontSize: 12, color: "#666" }}>
        Use your browser&apos;s Print (Save as PDF). This page hides itself when printing.
      </p>
      <div>
        <div
          style={{
            fontSize: 13,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "#666",
          }}
        >
          BookerReads drop point
        </div>
        <h1>{dp.name}</h1>
        <div style={{ color: "#444" }}>{dp.address}</div>
      </div>
      <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <h2>Dropping off or collecting a book?</h2>
      <ol>
        <li>Scan this code with your phone camera.</li>
        <li>Sign in if asked. Your loan for this venue appears.</li>
        <li>Enter the 6-character handoff code from the app.</li>
        <li>Leave the book on the BookerReads shelf, or take yours.</li>
      </ol>
      <div className="hours">
        {DAYS.map(([k, label]) => (
          <div key={k}>
            <div style={{ fontWeight: 600 }}>{label}</div>
            <div>{dp.hours[k] ? `${dp.hours[k]!.open}–${dp.hours[k]!.close}` : "Closed"}</div>
          </div>
        ))}
      </div>
      <div className="foot">
        Books left here belong to BookerReads members and are tracked by handoff code. Questions:{" "}
        {dp.contact}. Shelf capacity {dp.capacity}.
      </div>
    </div>
  );
}
