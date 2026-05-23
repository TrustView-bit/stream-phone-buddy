import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArmcloudEngine } from "armcloud-rtc";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Cloud Phone Viewer" },
      { name: "description", content: "Stream your webcam into a remote Android phone." },
    ],
  }),
  component: Index,
});

function Index() {
  const [status, setStatus] = useState("Idle");
  const [camSettings, setCamSettings] = useState<{ width?: number; height?: number; aspectRatio?: number } | null>(null);
  const [canvasSettings, setCanvasSettings] = useState<{ width?: number; height?: number; aspectRatio?: number } | null>(null);
  const engineRef = useRef<ArmcloudEngine | null>(null);

  const startCloudPhone = async () => {
    setStatus("Requesting token…");
    try {
      const test = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 720 },
          height: { ideal: 1280 },
          aspectRatio: { ideal: 9 / 16 },
        },
      });
      const settings = test.getVideoTracks()[0]?.getSettings();
      console.log("Camera settings:", settings);
      setCamSettings({ width: settings?.width, height: settings?.height, aspectRatio: settings?.aspectRatio });
      test.getTracks().forEach((t) => t.stop());
    } catch (_) {
      setStatus("Camera permission denied");
      return;
    }

    // Wrap getUserMedia so the SDK receives a portrait 720x1280 stream drawn via
    // canvas "cover" logic from the (often landscape) camera, with horizontal mirror.
    const w = window as unknown as { __gumPatched?: boolean };
    if (!w.__gumPatched) {
      const md = navigator.mediaDevices;
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        const stream = await orig(constraints);
        if (!constraints?.video) return stream;

        const track = stream.getVideoTracks()[0];
        if (!track) return stream;
        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play().catch(() => {});

        const CANVAS_W = 720;
        const CANVAS_H = 1280;
        const canvas = document.createElement("canvas");
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        const ctx = canvas.getContext("2d")!;
        let raf = 0;
        const draw = () => {
          const sw = video.videoWidth;
          const sh = video.videoHeight;
          if (sw && sh) {
            // "cover": always fill the entire canvas, crop the overflow.
            const scale = Math.max(canvas.width / sw, canvas.height / sh);
            const dw = sw * scale;
            const dh = sh * scale;
            const dx = (canvas.width - dw) / 2;
            const dy = (canvas.height - dh) / 2;
            ctx.save();
            // Horizontal flip (un-mirror front camera).
            ctx.translate(canvas.width, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(video, dx, dy, dw, dh);
            ctx.restore();
          }
          raf = requestAnimationFrame(draw);
        };
        draw();
        const portrait = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(30);
        // Report canvas stream dimensions to the UI once available.
        setTimeout(() => {
          const cs = portrait.getVideoTracks()[0]?.getSettings();
          setCanvasSettings({
            width: cs?.width ?? CANVAS_W,
            height: cs?.height ?? CANVAS_H,
            aspectRatio: cs?.aspectRatio ?? CANVAS_W / CANVAS_H,
          });
        }, 250);
        track.addEventListener("ended", () => {
          cancelAnimationFrame(raf);
          portrait.getTracks().forEach((t) => t.stop());
        });
        stream.getAudioTracks().forEach((t) => portrait.addTrack(t));
        return portrait;
      };
      w.__gumPatched = true;
    }

    const { data, error } = await supabase.functions.invoke("cloudphone-token", { body: {} });
    if (error) {
      setStatus("Token error: " + error.message);
      return;
    }
    const token = data.token;
    const padCode = data.padCode;

    engineRef.current = new ArmcloudEngine({
      baseUrl: "https://openapi-hk.armcloud.net",
      token,
      enableCamera: true,
      enableMicrophone: false,
      viewId: "phoneBox",
      deviceInfo: {
        padCode,
        userId: crypto.randomUUID(),
        mediaType: 3,
        rotateType: 0,
        videoStream: { resolution: 12, frameRate: 8, bitrate: 1 },
      },
      callbacks: {
        onInit: async ({ code }: { code: number | string }) => {
          if (code !== 0) {
            setStatus("Init failed: " + code);
            return;
          }
          const supported = await ArmcloudEngine.isSupported();
          if (!supported) {
            setStatus("This browser does not support WebRTC");
            return;
          }
          engineRef.current?.start();
        },
        onConnectSuccess: async () => {
          setStatus("Connected");
          engineRef.current!.startMediaStream(2);
          try {
            const s = await engineRef.current!.getInjectStreamStatus("camera" as any, 5000);
            setStatus("Connected · camera: " + (s as any).status);
          } catch (_) {
            setStatus("Connected · camera status unknown");
          }
        },
        onConnectFail: ({ msg }: { msg?: string }) => setStatus("Connect failed: " + msg),
        onAutoplayFailed: () => {
          const b = document.getElementById("playBtn");
          if (b) {
            b.style.display = "inline-block";
            b.onclick = () => engineRef.current?.startPlay();
          }
        },
        onAutoRecoveryTime: () => engineRef.current?.start(),
      },
    });
  };

  const stopCloudPhone = () => {
    if (engineRef.current) {
      engineRef.current.stop();
      engineRef.current = null;
      setStatus("Idle");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-0 py-8 sm:px-4">
        <h1 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
          Cloud Phone Viewer
        </h1>

        <div
          id="phoneBox"
          className="mx-auto aspect-[9/16] w-screen max-w-[100dvw] overflow-hidden bg-muted shadow-lg sm:w-[360px] sm:rounded-xl"
        />

        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={startCloudPhone}
            className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Start
          </button>
          <button
            onClick={stopCloudPhone}
            className="rounded-md border border-input bg-background px-6 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Stop
          </button>
          <button
            id="playBtn"
            hidden
            className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground"
          >
            Tap to play
          </button>
        </div>

        <pre className="w-full whitespace-pre-wrap break-all text-left text-xs text-muted-foreground">
          {status}
        </pre>

        {camSettings && (
          <div className="w-full text-center text-xs text-muted-foreground">
            Camera: {camSettings.width}×{camSettings.height} (aspect {camSettings.aspectRatio?.toFixed(3) ?? "n/a"})
          </div>
        )}
        {canvasSettings && (
          <div className="w-full text-center text-xs text-muted-foreground">
            Canvas stream: {canvasSettings.width}×{canvasSettings.height} (aspect {canvasSettings.aspectRatio?.toFixed(3) ?? "n/a"})
          </div>
        )}
      </div>
    </div>
  );
}
