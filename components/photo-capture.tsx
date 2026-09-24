"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { createUploadUrl } from "@/lib/photos/actions";
import { isLikelyGalleryPick, processPhoto } from "@/lib/photos/image";
import type { PhotoPurpose } from "@/lib/photos/storage";

type Status =
  | { kind: "idle" }
  | { kind: "camera" }
  | { kind: "processing" }
  | { kind: "uploading"; previewUrl: string }
  | { kind: "done"; previewUrl: string; path: string }
  | { kind: "error"; message: string; previewUrl?: string };

export type PhotoCaptureProps = {
  purpose: PhotoPurpose;
  /** Receives the Storage path once the upload succeeds; null when cleared. */
  onUploaded: (path: string | null) => void;
  label?: string;
  hint?: string;
  /** Hidden form field name to carry the path in a plain form post. */
  name?: string;
};

const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 }, height: { ideal: 1200 } },
  audio: false,
};

function cameraAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    window.isSecureContext
  );
}

/**
 * Camera-only photo input (Requirement 2.3). Opens a live camera view via
 * `getUserMedia` and snapshots it to a canvas, so "Take photo" and "Retake"
 * always go to the camera (a bare `<input capture>` falls back to the file
 * picker on desktop and some Android browsers). When the camera is denied or
 * unavailable we fall back to `<input capture="environment">`, still rejecting
 * gallery picks by file age. Resizes to 1600 px / JPEG q0.8 on-device
 * (Requirement 14.4) and PUTs straight to Storage via a signed URL.
 */
export function PhotoCapture({
  purpose,
  onUploaded,
  label = "Take a photo",
  hint,
  name,
}: PhotoCaptureProps) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const id = useId();

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  // Attach the stream once the <video> for the "camera" state has mounted.
  useEffect(() => {
    if (status.kind !== "camera" || !videoRef.current || !streamRef.current) return;
    videoRef.current.srcObject = streamRef.current;
    void videoRef.current.play().catch(() => undefined);
  }, [status.kind]);

  async function upload(source: Blob | File) {
    setStatus({ kind: "processing" });
    let previewUrl: string | undefined;
    try {
      const processed = await processPhoto(source);
      previewUrl = URL.createObjectURL(processed.blob);
      setStatus({ kind: "uploading", previewUrl });

      const target = await createUploadUrl(purpose);
      if (!target.ok) throw new Error(target.message);

      const res = await fetch(target.data.signedUrl, {
        method: "PUT",
        headers: { "content-type": "image/jpeg", "x-upsert": "false" },
        body: processed.blob,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);

      setStatus({ kind: "done", previewUrl, path: target.data.path });
      onUploaded(target.data.path);
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : "Something went wrong with the upload.",
        previewUrl,
      });
      onUploaded(null);
    }
  }

  async function handleFile(file: File) {
    if (isLikelyGalleryPick(file)) {
      setStatus({
        kind: "error",
        message:
          "Please take a new photo with the camera rather than choosing one from your gallery.",
      });
      onUploaded(null);
      return;
    }
    await upload(file);
  }

  function revokePreview() {
    if ("previewUrl" in status && status.previewUrl) URL.revokeObjectURL(status.previewUrl);
  }

  /** Open the live camera; fall back to the file input if that isn't possible. */
  async function openCamera() {
    revokePreview();
    onUploaded(null);
    if (!cameraAvailable()) {
      inputRef.current?.click();
      return;
    }
    try {
      stopCamera();
      streamRef.current = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      setStatus({ kind: "camera" });
    } catch {
      // Permission denied or no camera: let the browser's own capture UI handle it.
      inputRef.current?.click();
    }
  }

  async function snap() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    stopCamera();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92),
    );
    if (!blob) {
      setStatus({ kind: "error", message: "Couldn't capture the frame. Try again." });
      return;
    }
    await upload(blob);
  }

  function cancelCamera() {
    stopCamera();
    setStatus({ kind: "idle" });
  }

  function reset() {
    revokePreview();
    stopCamera();
    setStatus({ kind: "idle" });
    onUploaded(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  const busy = status.kind === "processing" || status.kind === "uploading";
  const preview = "previewUrl" in status ? status.previewUrl : undefined;

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />
      {name && status.kind === "done" && <input type="hidden" name={name} value={status.path} />}

      {status.kind === "camera" ? (
        <div className="relative overflow-hidden rounded-lg border bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="aspect-[4/3] w-full object-cover"
          />
          <div className="absolute inset-x-0 bottom-0 flex justify-center gap-2 p-3">
            <Button type="button" size="lg" onClick={() => void snap()}>
              Capture
            </Button>
            <Button type="button" size="lg" variant="outline" onClick={cancelCamera}>
              Cancel
            </Button>
          </div>
        </div>
      ) : preview ? (
        <div className="bg-muted relative overflow-hidden rounded-lg border">
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
          <img src={preview} alt="Your photo" className="aspect-[4/3] w-full object-cover" />
          {busy && (
            <div className="bg-background/60 absolute inset-0 flex items-center justify-center text-sm">
              Uploading…
            </div>
          )}
          {status.kind === "done" && (
            <span className="bg-background/90 absolute top-2 right-2 rounded px-2 py-0.5 text-xs">
              Uploaded
            </span>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void openCamera()}
          disabled={busy}
          className="text-muted-foreground flex aspect-[4/3] w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-sm disabled:cursor-default"
        >
          <span className="text-foreground font-medium">{busy ? "Processing…" : label}</span>
          {hint && <span className="text-xs">{hint}</span>}
        </button>
      )}

      {status.kind === "error" && (
        <p role="alert" className="text-destructive text-sm">
          {status.message}
        </p>
      )}

      {(status.kind === "done" || status.kind === "error") && (
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void openCamera()}>
            Retake
          </Button>
          {status.kind === "done" && (
            <Button type="button" variant="ghost" size="sm" onClick={reset}>
              Remove
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
