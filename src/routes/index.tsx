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
  const engineRef = useRef<ArmcloudEngine | null>(null);

  const startCloudPhone = async () => {
    setStatus("Requesting token…");
    try {
      await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (_) {
      setStatus("Camera permission denied");
      return;
    }

    // Mirror the webcam horizontally before injection (SDK exposes no mirror option).
    // Wrap getUserMedia so the SDK receives a horizontally-flipped MediaStream.
    const w = window as unknown as { __gumPatched?: boolean };
    if (!w.__gumPatched) {
      const md = navigator.mediaDevices;
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        const stream = await orig(constraints);
        if (!constraints?.video) return stream;
        const track = stream.getVideoTracks()[0];
        if (!track) return stream;
        const settings = track.getSettings();
        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play().catch(() => {});
        const width = settings.width ?? video.videoWidth ?? 640;
        const height = settings.height ?? video.videoHeight ?? 480;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        const fps = settings.frameRate ?? 30;
        let raf = 0;
        const draw = () => {
          ctx.save();
          ctx.translate(width, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(video, 0, 0, width, height);
          ctx.restore();
          raf = requestAnimationFrame(draw);
        };
        draw();
        const flipped = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(fps);
        track.addEventListener("ended", () => {
          cancelAnimationFrame(raf);
          flipped.getTracks().forEach((t) => t.stop());
        });
        // Keep original audio tracks if present
        stream.getAudioTracks().forEach((t) => flipped.addTrack(t));
        return flipped;
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
      </div>
    </div>
  );
}
