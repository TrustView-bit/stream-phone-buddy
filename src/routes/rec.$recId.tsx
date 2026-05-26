import { createFileRoute, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/rec/$recId")({
  head: () => ({
    meta: [
      { title: "Record video" },
      { name: "description", content: "Record and submit a video." },
    ],
  }),
  component: RecPage,
});

type Stage =
  | "intro"
  | "requesting"
  | "denied"
  | "ready"
  | "recording"
  | "preview"
  | "uploading"
  | "done"
  | "error";

const MAX_SECONDS = 120;

function pickMime() {
  const candidates = [
    "video/mp4;codecs=avc1,mp4a",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function RecPage() {
  const { recId } = useParams({ from: "/rec/$recId" });
  const [stage, setStage] = useState<Stage>("intro");
  const [label, setLabel] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [facing, setFacing] = useState<"user" | "environment">("environment");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const mimeRef = useRef<string>("");
  const timerRef = useRef<number | null>(null);

  // Load link metadata
  useEffect(() => {
    (async () => {
      const { data, error } = await (supabase as any)
        .from("recording_links")
        .select("label")
        .eq("id", recId)
        .maybeSingle();
      if (error || !data) {
        setStage("error");
        setError("Recording link not found.");
        return;
      }
      setLabel((data as any).label);
    })();
  }, [recId]);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const startCamera = async () => {
    setStage("requesting");
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setStage("ready");
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Camera permission denied");
      setStage("denied");
    }
  };

  const flipCamera = async () => {
    const next = facing === "user" ? "environment" : "user";
    setFacing(next);
    stopStream();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: next },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch (e: any) {
      setError(e?.message || "Could not switch camera");
    }
  };

  const startRecording = () => {
    if (!streamRef.current) return;
    const mime = pickMime();
    mimeRef.current = mime;
    chunksRef.current = [];
    try {
      const rec = new MediaRecorder(
        streamRef.current,
        mime ? { mimeType: mime } : undefined,
      );
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: mimeRef.current || "video/webm",
        });
        blobRef.current = blob;
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        setStage("preview");
        stopStream();
      };
      rec.start(250);
      recorderRef.current = rec;
      setSeconds(0);
      setStage("recording");
      timerRef.current = window.setInterval(() => {
        setSeconds((s) => {
          const n = s + 1;
          if (n >= MAX_SECONDS) stopRecording();
          return n;
        });
      }, 1000);
    } catch (e: any) {
      setError(e?.message || "Could not start recording");
      setStage("error");
    }
  };

  const stopRecording = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    try {
      recorderRef.current?.stop();
    } catch {}
  };

  const reRecord = async () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl("");
    blobRef.current = null;
    setSeconds(0);
    await startCamera();
  };

  const submit = async () => {
    if (!blobRef.current) return;
    setStage("uploading");
    setProgress(0);
    setError("");
    const mime = mimeRef.current || "video/webm";
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const path = `${recId}/${filename}`;

    try {
      // Use XHR for upload progress
      const { data: sessionData } = await supabase.auth.getSession();
      const token =
        sessionData.session?.access_token ||
        (import.meta as any).env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const url = `${(import.meta as any).env.VITE_SUPABASE_URL}/storage/v1/object/recordings/${path}`;

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.setRequestHeader(
          "apikey",
          (import.meta as any).env.VITE_SUPABASE_PUBLISHABLE_KEY,
        );
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.setRequestHeader("Content-Type", mime);
        xhr.setRequestHeader("x-upsert", "true");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`));
        };
        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.send(blobRef.current);
      });

      setStage("done");
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Upload failed");
      setStage("error");
    }
  };

  useEffect(() => {
    return () => {
      stopStream();
      if (timerRef.current) clearInterval(timerRef.current);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-xl flex-col px-4 py-8">
        <h1 className="text-xl font-semibold">{label || "Record a video"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {stage === "done"
            ? "Thank you!"
            : "Record a short video and submit it."}
        </p>

        <div className="mt-6 flex-1">
          {stage === "intro" && (
            <div className="rounded-lg border border-border bg-card p-6 text-center">
              <p className="mb-4 text-sm text-muted-foreground">
                Tap below to enable your camera and microphone.
              </p>
              <button
                onClick={startCamera}
                className="rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground"
              >
                Tap to start camera
              </button>
            </div>
          )}

          {stage === "requesting" && (
            <p className="text-sm text-muted-foreground">Requesting camera access…</p>
          )}

          {stage === "denied" && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
              <p className="mb-2 font-medium">Camera access denied</p>
              <p className="mb-4 text-sm text-muted-foreground">{error}</p>
              <button
                onClick={startCamera}
                className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground"
              >
                Try again
              </button>
            </div>
          )}

          {(stage === "ready" || stage === "recording") && (
            <div>
              <div className="relative overflow-hidden rounded-lg bg-black">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="aspect-[9/16] w-full object-cover"
                />
                {stage === "recording" && (
                  <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-xs text-white">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                    REC {fmt(seconds)} / {fmt(MAX_SECONDS)}
                  </div>
                )}
              </div>
              <div className="mt-4 flex justify-center gap-3">
                {stage === "ready" ? (
                  <>
                    <button
                      onClick={flipCamera}
                      className="rounded-md border border-input px-4 py-2 text-sm"
                    >
                      Flip
                    </button>
                    <button
                      onClick={startRecording}
                      className="rounded-md bg-red-600 px-6 py-2 text-sm font-medium text-white"
                    >
                      ● Record
                    </button>
                  </>
                ) : (
                  <button
                    onClick={stopRecording}
                    className="rounded-md bg-foreground px-6 py-2 text-sm font-medium text-background"
                  >
                    ■ Stop
                  </button>
                )}
              </div>
            </div>
          )}

          {stage === "preview" && (
            <div>
              <video
                ref={previewRef}
                src={previewUrl}
                controls
                playsInline
                className="aspect-[9/16] w-full rounded-lg bg-black object-cover"
              />
              <div className="mt-4 flex justify-center gap-3">
                <button
                  onClick={reRecord}
                  className="rounded-md border border-input px-4 py-2 text-sm"
                >
                  Re-record
                </button>
                <button
                  onClick={submit}
                  className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground"
                >
                  Submit
                </button>
              </div>
            </div>
          )}

          {stage === "uploading" && (
            <div className="rounded-lg border border-border bg-card p-6">
              <p className="mb-3 text-sm">Uploading… {progress}%</p>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {stage === "done" && (
            <div className="rounded-lg border border-border bg-card p-6 text-center">
              <p className="text-lg font-medium">✓ Submitted</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Thanks — your video has been sent.
              </p>
            </div>
          )}

          {stage === "error" && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
              <p className="mb-2 font-medium">Something went wrong</p>
              <p className="mb-4 text-sm text-muted-foreground">{error}</p>
              <button
                onClick={() => (blobRef.current ? submit() : startCamera())}
                className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
