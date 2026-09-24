"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toIsbn13 } from "@/lib/catalogue/isbn";

const DUPLICATE_WINDOW_MS = 2000;
const NATIVE_DECODE_INTERVAL_MS = 100;

type Stop = () => void;

type NativeDetector = new (opts: { formats: string[] }) => {
  detect: (src: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
};

/**
 * Starts decoding `video`, calling `onValue` for every raw barcode string.
 * Uses the native BarcodeDetector when present (Android Chrome); otherwise
 * lazy-loads @zxing/browser so it never lands in the shared bundle.
 */
async function startDecoding(
  video: HTMLVideoElement,
  onValue: (raw: string) => void,
): Promise<Stop> {
  const Native = (window as unknown as { BarcodeDetector?: NativeDetector }).BarcodeDetector;
  if (Native) {
    const detector = new Native({ formats: ["ean_13"] });
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      try {
        const hits = await detector.detect(video);
        if (hits[0]) onValue(hits[0].rawValue);
      } catch {
        // one bad frame; keep going
      }
      timer = setTimeout(tick, NATIVE_DECODE_INTERVAL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  const { BrowserMultiFormatReader } = await import("@zxing/browser");
  const reader = new BrowserMultiFormatReader(undefined, {
    delayBetweenScanAttempts: NATIVE_DECODE_INTERVAL_MS,
  });
  const controls = await reader.decodeFromVideoElement(video, (result) => {
    if (result) onValue(result.getText());
  });
  return () => controls.stop();
}

export function BarcodeScanner({
  onDetect,
  active = true,
}: {
  onDetect: (isbn13: string) => void;
  active?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const lastHit = useRef<{ value: string; at: number } | null>(null);
  // Keep the latest callback without restarting the camera when the parent re-renders.
  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect;

  useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let stopDecoding: Stop | undefined;

    const handleRaw = (raw: string) => {
      const isbn13 = toIsbn13(raw);
      if (!isbn13) return;
      const now = Date.now();
      const dupe =
        lastHit.current &&
        lastHit.current.value === raw &&
        now - lastHit.current.at < DUPLICATE_WINDOW_MS;
      if (dupe) return;
      lastHit.current = { value: raw, at: now };
      navigator.vibrate?.(60);
      onDetectRef.current(isbn13);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();
        stopDecoding = await startDecoding(video, handleRaw);
        if (cancelled) stopDecoding();
      } catch (e) {
        if (cancelled) return;
        const name = (e as { name?: string }).name;
        setError(
          name === "NotAllowedError"
            ? "Camera access was blocked. Allow the camera in your browser settings, or type the ISBN below."
            : "Couldn't start the camera. Type the ISBN below instead.",
        );
      }
    })();

    return () => {
      cancelled = true;
      stopDecoding?.();
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }, [active]);

  function submitManual() {
    const isbn13 = toIsbn13(manual);
    if (!isbn13) {
      setManualError(
        "That doesn't look like a valid ISBN. It's the 10 or 13 digits above the barcode.",
      );
      return;
    }
    setManualError(null);
    onDetectRef.current(isbn13);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-black">
        <video ref={videoRef} className="h-full w-full object-cover" playsInline muted />
        <div className="pointer-events-none absolute inset-x-8 top-1/2 h-16 -translate-y-1/2 rounded border-2 border-white/80" />
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-4 text-center text-sm text-white">
            {error}
          </div>
        )}
      </div>
      <p className="text-muted-foreground text-center text-xs">
        Point the camera at the barcode on the back cover.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submitManual();
        }}
      >
        <Input
          inputMode="numeric"
          placeholder="Or type the ISBN"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          aria-label="ISBN"
          aria-invalid={manualError ? true : undefined}
        />
        <Button type="submit" variant="outline">
          Find
        </Button>
      </form>
      {manualError && (
        <p role="alert" className="text-destructive text-sm">
          {manualError}
        </p>
      )}
    </div>
  );
}
