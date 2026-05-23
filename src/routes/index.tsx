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
  const [injectionTrace, setInjectionTrace] = useState<string | null>(null);
  const engineRef = useRef<ArmcloudEngine | null>(null);
  const rawCameraRef = useRef<MediaStream | null>(null);
  const canvasCameraRef = useRef<MediaStream | null>(null);
  const drawRafRef = useRef<number | null>(null);

  const cleanupCameraPipeline = () => {
    if (drawRafRef.current !== null) {
      cancelAnimationFrame(drawRafRef.current);
      drawRafRef.current = null;
    }
    canvasCameraRef.current?.getTracks().forEach((track) => track.stop());
    rawCameraRef.current?.getTracks().forEach((track) => track.stop());
    canvasCameraRef.current = null;
    rawCameraRef.current = null;
  };

  const startCloudPhone = async () => {
    setStatus("Requesting token…");
    setInjectionTrace(null);
    cleanupCameraPipeline();
    try {
      const raw = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 720 },
          height: { ideal: 1280 },
          aspectRatio: { ideal: 9 / 16 },
        },
      });
      rawCameraRef.current = raw;
      const rawTrack = raw.getVideoTracks()[0];
      (rawTrack as MediaStreamTrack & { __cloudPhoneSource?: string }).__cloudPhoneSource = "raw-camera-for-canvas-only";
      const settings = rawTrack?.getSettings();
      console.log("Camera settings:", settings);
      setCamSettings({ width: settings?.width, height: settings?.height, aspectRatio: settings?.aspectRatio });
    } catch (_) {
      setStatus("Camera permission denied");
      return;
    }

    // The SDK does not accept an app-supplied MediaStream in startMediaStream().
    // It calls navigator.mediaDevices.getUserMedia() internally, so force that
    // exact SDK request to receive the canvas captureStream instead of raw camera.
    const rawStream = rawCameraRef.current;
    const rawTrack = rawStream?.getVideoTracks()[0];
    if (!rawStream || !rawTrack) {
      setStatus("Camera stream unavailable");
      return;
    }

    const video = document.createElement("video");
    video.srcObject = rawStream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});

    const CANVAS_W = 720;
    const CANVAS_H = 1280;
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext("2d")!;

    const draw = () => {
      const sw = video.videoWidth || rawTrack.getSettings().width || CANVAS_W;
      const sh = video.videoHeight || rawTrack.getSettings().height || CANVAS_H;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (sw && sh && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        // "cover": always fill the whole portrait canvas, cropping overflow.
        const scale = Math.max(canvas.width / sw, canvas.height / sh);
        const dw = sw * scale;
        const dh = sh * scale;
        const dx = (canvas.width - dw) / 2;
        const dy = (canvas.height - dh) / 2;
        ctx.save();
        // Un-mirror the front-camera source before captureStream() sees it.
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, dx, dy, dw, dh);
        ctx.restore();
      }
      // Temporary proof marker: if this appears in the cloud phone camera,
      // the SDK is publishing this canvas stream, not the raw camera stream.
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(0, 0, 96, 96);
      drawRafRef.current = requestAnimationFrame(draw);
    };
    draw();

    const portrait = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(30);
    (portrait as MediaStream & { __cloudPhoneSource?: string }).__cloudPhoneSource = "canvas-captureStream";
    const portraitTrack = portrait.getVideoTracks()[0];
    (portraitTrack as MediaStreamTrack & { __cloudPhoneSource?: string }).__cloudPhoneSource = "canvas-captureStream";
    canvasCameraRef.current = portrait;
    const cs = portraitTrack?.getSettings();
    setCanvasSettings({
      width: cs?.width ?? CANVAS_W,
      height: cs?.height ?? CANVAS_H,
      aspectRatio: cs?.aspectRatio ?? CANVAS_W / CANVAS_H,
    });

    rawTrack.addEventListener("ended", cleanupCameraPipeline);

    const w = window as unknown as {
      __cloudPhoneOrigGetUserMedia?: typeof navigator.mediaDevices.getUserMedia;
      __cloudPhoneGumPatchVersion?: string;
      __cloudPhoneOrigAddTrack?: typeof RTCPeerConnection.prototype.addTrack;
      __cloudPhoneAddTrackPatched?: boolean;
    };

    if (!w.__cloudPhoneOrigGetUserMedia) {
      const md = navigator.mediaDevices;
      w.__cloudPhoneOrigGetUserMedia = md.getUserMedia.bind(md);
    }

    if (w.__cloudPhoneGumPatchVersion !== "canvas-v3-red-marker") {
      const md = navigator.mediaDevices;
      md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        if (!constraints?.video) return w.__cloudPhoneOrigGetUserMedia!(constraints);

        const canvasStream = canvasCameraRef.current;
        const canvasTrack = canvasStream?.getVideoTracks()[0];
        if (!canvasStream || !canvasTrack || canvasTrack.readyState === "ended") {
          throw new DOMException("Canvas camera stream is not ready for SDK injection", "NotReadableError");
        }

        const sdkStream = new MediaStream([canvasTrack]);
        (sdkStream as MediaStream & { __cloudPhoneSource?: string }).__cloudPhoneSource = "canvas-captureStream";
        const injectedSettings = canvasTrack.getSettings();
        console.log("[CloudPhone] SDK getUserMedia intercepted; returning canvas stream", {
          constraints,
          source: "canvas-captureStream",
          settings: injectedSettings,
        });
        setInjectionTrace(
          `SDK getUserMedia: canvas captureStream ${injectedSettings.width ?? CANVAS_W}×${injectedSettings.height ?? CANVAS_H}`,
        );
        return sdkStream;
      };
      w.__cloudPhoneGumPatchVersion = "canvas-v3-red-marker";
    }

    if (!w.__cloudPhoneAddTrackPatched && window.RTCPeerConnection?.prototype?.addTrack) {
      w.__cloudPhoneOrigAddTrack = RTCPeerConnection.prototype.addTrack;
      RTCPeerConnection.prototype.addTrack = function patchedAddTrack(track: MediaStreamTrack, ...streams: MediaStream[]) {
        const source = (track as MediaStreamTrack & { __cloudPhoneSource?: string }).__cloudPhoneSource ?? "unknown";
        const settings = track.getSettings?.();
        console.log("[CloudPhone] RTCPeerConnection.addTrack", { kind: track.kind, source, settings });
        if (track.kind === "video") {
          setInjectionTrace((prev) =>
            `${prev ?? "SDK getUserMedia: not observed"}\nWebRTC addTrack: ${source} ${settings?.width ?? "?"}×${settings?.height ?? "?"}`,
          );
        }
        return w.__cloudPhoneOrigAddTrack!.call(this, track, ...streams);
      };
      w.__cloudPhoneAddTrackPatched = true;
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
