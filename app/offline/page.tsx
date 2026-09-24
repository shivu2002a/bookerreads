import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Offline" };
// Precached by the service worker; must render without data.
export const dynamic = "force-static";

export default function OfflinePage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">You&apos;re offline</h1>
      <p className="text-muted-foreground text-sm">
        Pages you&apos;ve opened recently still work. Handoff and return confirmations you make now
        are saved on this device and sent when you&apos;re back online.
      </p>
      <Link href="/requests" className="text-sm underline">
        Go to my loans
      </Link>
    </div>
  );
}
