import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
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
  const [videoDebug, setVideoDebug] = useState<string>("video: not started");
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
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
    if (hiddenVideoRef.current) {
      try {
        hiddenVideoRef.current.pause();
        hiddenVideoRef.current.srcObject = null;
        hiddenVideoRef.current.remove();
      } catch (_) {}
      hiddenVideoRef.current = null;
    }
  };

  const startCloudPhone = async () => {
    if (engineRef.current) {
      setStatus("Releasing previous session…");
      stopCloudPhone();
      await new Promise((r) => setTimeout(r, 2000));
    }
    setStatus("Requesting token…");
    setInjectionTrace(null);
    cleanupCameraPipeline();
    const existingWindowPatch = window as unknown as { __cloudPhoneOrigGetUserMedia?: typeof navigator.mediaDevices.getUserMedia };
    const getRawUserMedia = existingWindowPatch.__cloudPhoneOrigGetUserMedia ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    try {
      const raw = await getRawUserMedia({
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
    video.defaultMuted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "true");
    video.setAttribute("webkit-playsinline", "true");
    video.setAttribute("muted", "");
    video.setAttribute("autoplay", "");
    // Must stay rendered (not display:none / visibility:hidden) so mobile browsers decode frames.
    video.style.position = "absolute";
    video.style.left = "0";
    video.style.top = "0";
    video.style.width = "1px";
    video.style.height = "1px";
    video.style.opacity = "0.01";
    video.style.display = "block";
    video.style.visibility = "visible";
    video.style.pointerEvents = "none";
    video.style.zIndex = "-1";
    document.body.appendChild(video);
    hiddenVideoRef.current = video;

    setVideoDebug(`video: created, readyState=${video.readyState}`);

    const waitForData = new Promise<void>((resolve) => {
      if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
      const onReady = () => {
        if (video.videoWidth > 0) {
          video.removeEventListener("loadeddata", onReady);
          video.removeEventListener("loadedmetadata", onReady);
          resolve();
        }
      };
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("loadedmetadata", onReady);
    });

    try {
      await video.play();
    } catch (e) {
      console.warn("[CloudPhone] video.play() rejected", e);
    }
    await waitForData;
    setVideoDebug(`video: playing readyState=${video.readyState} ${video.videoWidth}×${video.videoHeight}`);

    const CANVAS_W = 720;
    const CANVAS_H = 1280;
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext("2d")!;

    let frameCount = 0;
    const draw = () => {
      const sw = video.videoWidth;
      const sh = video.videoHeight;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (sw && sh && video.readyState >= 2) {
        const scale = Math.max(canvas.width / sw, canvas.height / sh);
        const dw = sw * scale;
        const dh = sh * scale;
        const dx = (canvas.width - dw) / 2;
        const dy = (canvas.height - dh) / 2;
        ctx.save();
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        try {
          ctx.drawImage(video, dx, dy, dw, dh);
        } catch (e) {
          console.warn("[CloudPhone] drawImage failed", e);
        }
        ctx.restore();
      }
      // Red diagnostic square — confirms RAF loop is running.
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(0, 0, 96, 96);
      frameCount++;
      if (frameCount % 30 === 0) {
        setVideoDebug(`video: rs=${video.readyState} ${video.videoWidth}×${video.videoHeight} · frames=${frameCount}`);
      }
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
      __cloudPhoneOrigAddTransceiver?: typeof RTCPeerConnection.prototype.addTransceiver;
      __cloudPhoneAddTransceiverPatched?: boolean;
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

    if (!w.__cloudPhoneAddTrackPatched && typeof window.RTCPeerConnection?.prototype?.addTrack === "function") {
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

    if (!w.__cloudPhoneAddTransceiverPatched && typeof window.RTCPeerConnection?.prototype?.addTransceiver === "function") {
      w.__cloudPhoneOrigAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
      RTCPeerConnection.prototype.addTransceiver = function patchedAddTransceiver(
        trackOrKind: MediaStreamTrack | string,
        init?: RTCRtpTransceiverInit,
      ) {
        if (trackOrKind instanceof MediaStreamTrack) {
          const source = (trackOrKind as MediaStreamTrack & { __cloudPhoneSource?: string }).__cloudPhoneSource ?? "unknown";
          const settings = trackOrKind.getSettings?.();
          console.log("[CloudPhone] RTCPeerConnection.addTransceiver", { kind: trackOrKind.kind, source, settings });
          if (trackOrKind.kind === "video") {
            setInjectionTrace((prev) =>
              `${prev ?? "SDK getUserMedia: not observed"}\nWebRTC addTransceiver: ${source} ${settings?.width ?? "?"}×${settings?.height ?? "?"}`,
            );
          }
        }
        return w.__cloudPhoneOrigAddTransceiver!.call(this, trackOrKind, init);
      };
      w.__cloudPhoneAddTransceiverPatched = true;
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
          try {
            await engineRef.current!.startMediaStream(2);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setStatus("Camera injection error: " + message);
            setInjectionTrace((prev) => `${prev ?? "SDK camera injection attempted"}\nError: ${message}`);
            return;
          }
          try {
            const s = await engineRef.current!.getInjectStreamStatus("camera" as any, 5000);
            setStatus("Connected · camera: " + (s as any).status);
          } catch (_) {
            setStatus("Connected · camera status unknown");
          }
        },
        onConnectFail: ({ msg }: { msg?: string }) => {
          setStatus("Connect failed: " + msg + " · releasing session");
          stopCloudPhoneRef.current();
        },
        onConnectionStateChanged: (payload: { state: number }) => {
          // state 4/5/6 typically indicate failed/closed/disconnected in WebRTC-ish state machines
          if (payload?.state >= 4) {
            setStatus("Connection state " + payload.state + " · releasing session");
            stopCloudPhoneRef.current();
          }
        },
        onErrorMessage: (payload: { msg?: string; code?: number | string }) => {
          setStatus("Error: " + (payload?.msg ?? payload?.code ?? "unknown") + " · releasing session");
          stopCloudPhoneRef.current();
        },
        onUserLeave: (event: { reason?: string | number }) => {
          setStatus("Session ended: " + (event?.reason ?? "user leave") + " · releasing");
          stopCloudPhoneRef.current();
        },

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
    try {
      if (engineRef.current) {
        try {
          engineRef.current.stop();
        } catch (e) {
          console.warn("[CloudPhone] engine.stop() threw", e);
        }
        engineRef.current = null;
        setStatus("Idle");
      }
      cleanupCameraPipeline();
    } catch (e) {
      console.warn("[CloudPhone] stopCloudPhone error", e);
    }
  };

  const stopCloudPhoneRef = useRef(stopCloudPhone);
  stopCloudPhoneRef.current = stopCloudPhone;

  useEffect(() => {
    const handler = () => stopCloudPhoneRef.current();
    const visHandler = () => {
      if (document.visibilityState === "hidden") stopCloudPhoneRef.current();
    };
    window.addEventListener("beforeunload", handler);
    window.addEventListener("pagehide", handler);
    document.addEventListener("visibilitychange", visHandler);
    return () => {
      window.removeEventListener("beforeunload", handler);
      window.removeEventListener("pagehide", handler);
      document.removeEventListener("visibilitychange", visHandler);
      stopCloudPhoneRef.current();
    };
  }, []);


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
        <div className="w-full text-center text-xs text-muted-foreground">
          {videoDebug}
        </div>
        {injectionTrace && (
          <pre className="w-full whitespace-pre-wrap break-all text-left text-xs text-muted-foreground">
            {injectionTrace}
          </pre>
        )}
      </div>
    </div>
  );
}
