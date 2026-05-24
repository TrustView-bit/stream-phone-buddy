import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArmcloudEngine } from "armcloud-rtc";

export type CloudPhoneMode = "injector" | "viewer";
export type CameraMode = "dynamic" | "locked_back" | "locked_front";
type Facing = "back" | "front";

export interface QualityProfile {
  definitionId: number;
  framerateId: number;
  bitrateId: number;
}

export interface UseCloudPhoneOptions {
  mode: CloudPhoneMode;
  cameraMode?: CameraMode;
  requiredCamera?: Facing;
  padCode?: string;
  viewId?: string;
  backQuality?: QualityProfile;
  frontQuality?: QualityProfile;
}

export interface UseCloudPhoneResult {
  status: string;
  start: () => Promise<void>;
  stop: () => void;
  refreshStream: () => Promise<void>;
}

export function useCloudPhone(options: UseCloudPhoneOptions): UseCloudPhoneResult {
  const {
    mode,
    cameraMode = "dynamic",
    requiredCamera = "back",
    padCode: padCodeOverride,
    viewId = "phoneBox",
    backQuality = { definitionId: 17, framerateId: 6, bitrateId: 11 },
    frontQuality = { definitionId: 15, framerateId: 8, bitrateId: 8 },
  } = options;

  const [status, setStatus] = useState("Idle");
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<ArmcloudEngine | null>(null);
  const rawCameraRef = useRef<MediaStream | null>(null);
  const canvasCameraRef = useRef<MediaStream | null>(null);
  const drawRafRef = useRef<number | null>(null);

  // Live-updating facing for the draw loop's flip decision.
  const currentFacingRef = useRef<Facing>("back");

  // Live config so callbacks read latest values.
  const cameraModeRef = useRef<CameraMode>(cameraMode);
  cameraModeRef.current = cameraMode;
  const requiredCameraRef = useRef<Facing>(requiredCamera);
  requiredCameraRef.current = requiredCamera;
  const backQualityRef = useRef<QualityProfile>(backQuality);
  backQualityRef.current = backQuality;
  const frontQualityRef = useRef<QualityProfile>(frontQuality);
  frontQualityRef.current = frontQuality;

  // Switch coordination
  const switchInProgressRef = useRef(false);
  const pendingSwitchRef = useRef<Facing | null>(null);
  const lastSwitchAtRef = useRef(0);
  const isRefreshingRef = useRef(false);
  const viewerAutoRefreshTimerRef = useRef<number | null>(null);
  const lastViewerAutoRefreshAtRef = useRef(0);

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

  const stop = () => {
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
      console.warn("[CloudPhone] stop error", e);
    }
  };

  const stopRef = useRef(stop);
  stopRef.current = stop;
  const startRef = useRef<(() => Promise<void>) | null>(null);

  /**
   * Acquire a raw camera MediaStream for the requested facing using strict
   * device-label/facingMode matching. Returns null on failure. No fallback to
   * the other camera — caller decides what to do.
   */
  const acquireCameraStream = async (facing: Facing): Promise<{ stream: MediaStream | null; error: string }> => {
    const w = window as unknown as { __cloudPhoneOrigGetUserMedia?: typeof navigator.mediaDevices.getUserMedia };
    const getRawUserMedia = w.__cloudPhoneOrigGetUserMedia ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    let videoInputs: MediaDeviceInfo[] = [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      videoInputs = devices.filter((d) => d.kind === "videoinput");
    } catch (e) {
      console.warn("[CloudPhone] enumerateDevices failed", e);
    }

    const matchBack = (l: string) => {
      const s = l.toLowerCase();
      return /(back|rear|environment)/.test(s) && !/(front|user|face)/.test(s);
    };
    const matchFront = (l: string) => /(front|user|face)/.test(l.toLowerCase());
    const matcher = facing === "back" ? matchBack : matchFront;
    const matches = videoInputs.filter((d) => matcher(d.label));
    const preferred = matches.find((d) => /(main|\b0\b)/i.test(d.label)) ?? matches[0];

    let stream: MediaStream | null = null;
    let error = "";

    if (preferred) {
      try {
        stream = await getRawUserMedia({
          video: {
            deviceId: { exact: preferred.deviceId },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
        });
      } catch (e) {
        const err = e as { name?: string; message?: string };
        error = `deviceId exact failed: ${err?.name ?? "Error"}: ${err?.message ?? String(e)}`;
        console.warn("[CloudPhone]", error);
      }
    }

    if (!stream) {
      try {
        stream = await getRawUserMedia({
          video: {
            facingMode: { exact: facing === "back" ? "environment" : "user" },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
        });
      } catch (e) {
        const err = e as { name?: string; message?: string };
        error += ` | facingMode exact failed: ${err?.name ?? "Error"}: ${err?.message ?? String(e)}`;
      }
    }

    if (stream) {
      const track = stream.getVideoTracks()[0];
      try {
        const caps = track.getCapabilities?.() ?? {};
        const maxW = caps.width?.max;
        const maxH = caps.height?.max;
        if (maxW && maxH) {
          try {
            await track.applyConstraints({ width: { ideal: maxW }, height: { ideal: maxH } });
          } catch (_) {}
        }
      } catch (_) {}
      const s = track?.getSettings();
      console.log(
        `[CloudPhone] Camera acquired: ${facing} | ${track?.label ?? "(no label)"} | ${s?.width ?? "?"}×${s?.height ?? "?"} | facingMode=${s?.facingMode ?? "?"}`,
      );
    }

    return { stream, error };
  };

  /**
   * Live-swap the raw camera feeding the hidden video element. The canvas,
   * canvas captureStream, hidden video element and engine connection stay
   * alive; only the camera source changes.
   */
  const switchToCamera = async (target: Facing) => {
    if (cameraModeRef.current !== "dynamic") return;
    if (!hiddenVideoRef.current) return;
    if (currentFacingRef.current === target && rawCameraRef.current?.getVideoTracks()[0]?.readyState === "live") {
      return;
    }

    // Debounce / queue
    const now = Date.now();
    if (now - lastSwitchAtRef.current < 250) {
      pendingSwitchRef.current = target;
    }
    if (switchInProgressRef.current) {
      pendingSwitchRef.current = target;
      return;
    }

    switchInProgressRef.current = true;
    lastSwitchAtRef.current = Date.now();

    try {
      setStatus(`Switching camera → ${target}…`);
      const { stream: newStream, error } = await acquireCameraStream(target);
      if (!newStream) {
        console.warn(`[CloudPhone] Failed to switch to ${target}, keeping current camera.`, error);
        setStatus(`Camera switch to ${target} failed; keeping ${currentFacingRef.current}`);
        return;
      }

      // Stop old raw tracks, keep canvas + captureStream + engine intact.
      const oldStream = rawCameraRef.current;
      try { oldStream?.getTracks().forEach((t) => t.stop()); } catch (_) {}

      rawCameraRef.current = newStream;
      const newTrack = newStream.getVideoTracks()[0];
      (newTrack as MediaStreamTrack & { __cloudPhoneSource?: string }).__cloudPhoneSource = "raw-camera-for-canvas-only";

      const video = hiddenVideoRef.current;
      if (video) {
        video.srcObject = newStream;
        try { await video.play(); } catch (e) { console.warn("[CloudPhone] video.play() after switch rejected", e); }
      }

      currentFacingRef.current = target;
      requiredCameraRef.current = target;

      // Apply per-camera quality profile (dynamic mode only).
      // Back = sharp/static detail; Front = smoother for people/movement.
      const profile = target === "front" ? frontQualityRef.current : backQualityRef.current;
      try {
        await (engineRef.current as any)?.setStreamConfig?.(profile);
        console.log("[CloudPhone] setStreamConfig applied for", target, profile);
      } catch (e) {
        console.warn("[CloudPhone] setStreamConfig on switch failed", e);
      }
      setStatus(`Camera switched: ${target}`);
    } catch (e) {
      console.warn("[CloudPhone] switchToCamera error", e);
    } finally {
      switchInProgressRef.current = false;
      const pending = pendingSwitchRef.current;
      pendingSwitchRef.current = null;
      if (pending && pending !== currentFacingRef.current) {
        // Process queued request
        setTimeout(() => { void switchToCamera(pending); }, 0);
      }
    }
  };

  const start = async () => {
    if (engineRef.current) {
      setStatus("Releasing previous session…");
      stopRef.current();
      await new Promise((r) => setTimeout(r, 2000));
    }
    setStatus("Requesting token…");
    cleanupCameraPipeline();

    // Initial facing: locked modes force their value; dynamic mode starts with requiredCamera as seed.
    const initialFacing: Facing =
      cameraMode === "locked_back" ? "back" :
      cameraMode === "locked_front" ? "front" :
      requiredCamera;
    currentFacingRef.current = initialFacing;
    requiredCameraRef.current = initialFacing;

    if (mode === "injector") {
      // Permission probe + label population
      const existingWindowPatch = window as unknown as { __cloudPhoneOrigGetUserMedia?: typeof navigator.mediaDevices.getUserMedia };
      const getRawUserMedia = existingWindowPatch.__cloudPhoneOrigGetUserMedia ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      try {
        const temp = await getRawUserMedia({ video: { width: { ideal: 3840 }, height: { ideal: 2160 } } });
        temp.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        await new Promise((r) => setTimeout(r, 500));
      } catch (e) {
        console.warn("[CloudPhone] initial permission probe failed", e);
        setStatus("Camera permission denied");
        return;
      }

      const { stream: raw, error: acquireError } = await acquireCameraStream(initialFacing);
      if (!raw) {
        const msg = `Required ${initialFacing} camera not available`;
        console.warn("[CloudPhone]", msg, acquireError);
        setStatus(msg);
        return;
      }

      rawCameraRef.current = raw;
      const rawTrackInit = raw.getVideoTracks()[0];
      (rawTrackInit as MediaStreamTrack & { __cloudPhoneSource?: string }).__cloudPhoneSource = "raw-camera-for-canvas-only";

      const settings = rawTrackInit?.getSettings();
      const finalW = settings?.width ?? 0;
      const finalH = settings?.height ?? 0;
      if (finalW > 0 && finalW < 1280) {
        setStatus(`Low camera resolution: ${finalW}×${finalH} (hardware max)`);
      }

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

      const playPromise = video.play().catch((e) => {
        console.warn("[CloudPhone] video.play() rejected", e);
      });

      const waitForData = new Promise<void>((resolve) => {
        if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
        const onReady = () => {
          if (video.readyState >= 2 && video.videoWidth > 0) {
            video.removeEventListener("loadeddata", onReady);
            video.removeEventListener("loadedmetadata", onReady);
            video.removeEventListener("canplay", onReady);
            resolve();
          }
        };
        video.addEventListener("loadeddata", onReady);
        video.addEventListener("loadedmetadata", onReady);
        video.addEventListener("canplay", onReady);
      });

      await playPromise;
      await waitForData;
      console.log(`[CloudPhone] video ready: ${video.videoWidth}×${video.videoHeight} rs=${video.readyState}`);

      const CANVAS_W = 1080;
      const CANVAS_H = 1920;

      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      canvas.style.position = "fixed";
      canvas.style.left = "-10000px";
      canvas.style.top = "0";
      canvas.style.width = "360px";
      canvas.style.height = "640px";
      canvas.style.opacity = "1";
      canvas.style.background = "#000";
      canvas.style.pointerEvents = "none";
      canvas.style.zIndex = "9999";
      document.body.appendChild(canvas);
      (window as any).__cloudPhoneDrawCanvas = canvas;
      const ctx = canvas.getContext("2d")!;

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const draw = () => {
        const v = hiddenVideoRef.current;
        if (!v) {
          drawRafRef.current = requestAnimationFrame(draw);
          return;
        }
        const sw = v.videoWidth;
        const sh = v.videoHeight;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (sw && sh && v.readyState >= 2) {
          const scale = Math.max(canvas.width / sw, canvas.height / sh);
          const dw = sw * scale;
          const dh = sh * scale;
          const dx = (canvas.width - dw) / 2;
          const dy = (canvas.height - dh) / 2;
          ctx.save();
          // No horizontal flip in dynamic-switch context: front camera mirroring
          // is handled downstream by the cloud phone; back camera is not mirrored.
          try {
            ctx.drawImage(v, dx, dy, dw, dh);
          } catch (e) {
            console.warn("[CloudPhone] drawImage failed", e);
          }
          ctx.restore();
        }
        drawRafRef.current = requestAnimationFrame(draw);
      };
      draw();

      const portrait = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(30);
      (portrait as MediaStream & { __cloudPhoneSource?: string }).__cloudPhoneSource = "canvas-captureStream";
      const portraitTrack = portrait.getVideoTracks()[0];
      (portraitTrack as MediaStreamTrack & { __cloudPhoneSource?: string }).__cloudPhoneSource = "canvas-captureStream";
      canvasCameraRef.current = portrait;

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

      if (w.__cloudPhoneGumPatchVersion !== "canvas-v4-visible") {
        const md = navigator.mediaDevices;
        md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
          if (!constraints?.video) return w.__cloudPhoneOrigGetUserMedia!(constraints);

          const canvasStream = canvasCameraRef.current;
          const canvasTrack = canvasStream?.getVideoTracks()[0];
          if (!canvasStream || !canvasTrack || canvasTrack.readyState === "ended") {
            throw new DOMException("Canvas stream is not ready for SDK injection", "NotReadableError");
          }

          const sdkStream = new MediaStream([canvasTrack.clone()]);
          (sdkStream as MediaStream & { __cloudPhoneSource?: string }).__cloudPhoneSource = "canvas-captureStream";
          setStatus("Camera active");
          return sdkStream;
        };
        w.__cloudPhoneGumPatchVersion = "canvas-v4-visible";
      }

      if (!w.__cloudPhoneAddTrackPatched && typeof window.RTCPeerConnection?.prototype?.addTrack === "function") {
        w.__cloudPhoneOrigAddTrack = RTCPeerConnection.prototype.addTrack;
        RTCPeerConnection.prototype.addTrack = function patchedAddTrack(track: MediaStreamTrack, ...streams: MediaStream[]) {
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
          return w.__cloudPhoneOrigAddTransceiver!.call(this, trackOrKind, init);
        };
        w.__cloudPhoneAddTransceiverPatched = true;
      }
    }

    if (!padCodeOverride) {
      setStatus("Missing pad code");
      return;
    }
    const { data, error } = await supabase.functions.invoke("cloudphone-token", {
      body: { padCode: padCodeOverride },
    });
    if (error) {
      setStatus("Token error: " + error.message);
      return;
    }
    const token = data.token;
    const padCode = padCodeOverride ?? data.padCode;

    const isInjector = mode === "injector";

    engineRef.current = new ArmcloudEngine({
      baseUrl: "https://openapi-hk.armcloud.net",
      token,
      enableCamera: isInjector,
      enableMicrophone: false,
      viewId,
      deviceInfo: {
        padCode,
        userId: crypto.randomUUID(),
        mediaType: 3,
        rotateType: 0,
        videoStream: {
          resolution: (initialFacing === "front" ? frontQuality : backQuality).definitionId,
          frameRate: (initialFacing === "front" ? frontQuality : backQuality).framerateId,
          bitrate: (initialFacing === "front" ? frontQuality : backQuality).bitrateId,
        },
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
          if (!isInjector) {
            return;
          }
          try {
            await engineRef.current!.startMediaStream(2);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setStatus("Camera injection error: " + message);
            return;
          }
          try {
            await (engineRef.current as any).setStreamConfig(initialFacing === "front" ? frontQualityRef.current : backQualityRef.current);
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            setStatus("setStreamConfig error: " + m);
          }
          try {
            await (engineRef.current as any).setScreenResolution({ width: 1080, height: 1920, dpi: 480, type: 'updateDensity' });
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            setStatus("setScreenResolution error: " + m);
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
          stopRef.current();
        },
        onConnectionStateChanged: (payload: { state: number }) => {
          if (payload?.state >= 4) {
            setStatus("Connection state " + payload.state + " · releasing session");
            stopRef.current();
          }
        },
        onErrorMessage: (payload: { msg?: string; code?: number | string }) => {
          setStatus("Error: " + (payload?.msg ?? payload?.code ?? "unknown") + " · releasing session");
          stopRef.current();
        },
        onUserLeave: (event: { reason?: string | number }) => {
          setStatus("Session ended: " + (event?.reason ?? "user leave") + " · releasing");
          stopRef.current();
        },
        onAutoplayFailed: () => {
          const b = document.getElementById("playBtn");
          if (b) {
            b.style.display = "inline-block";
            b.onclick = () => engineRef.current?.startPlay();
          }
        },
        onMediaDevicesToggle: (stats: { type?: string; enabled?: boolean; isFront?: boolean }) => {
          console.log("[CloudPhone] onMediaDevicesToggle", stats);
          const t = stats?.type;
          if (t !== "camera" && t !== "media") return;
          if (!isInjector) {
            if (stats?.enabled === true) {
              const now = Date.now();
              if (now - lastViewerAutoRefreshAtRef.current > 1500 && viewerAutoRefreshTimerRef.current === null) {
                lastViewerAutoRefreshAtRef.current = now;
                viewerAutoRefreshTimerRef.current = window.setTimeout(() => {
                  viewerAutoRefreshTimerRef.current = null;
                  void refreshStream();
                }, 250);
              }
            }
            return;
          }
          // Locked modes: ignore entirely.
          if (cameraModeRef.current !== "dynamic") return;
          if (stats?.enabled !== true) return;
          const target: Facing = stats?.isFront ? "front" : "back";
          void switchToCamera(target);
        },
        onAutoRecoveryTime: () => engineRef.current?.start(),
      },
    });
  };

  useEffect(() => {
    const handler = () => stopRef.current();
    const visHandler = () => {
      if (document.visibilityState === "hidden") stopRef.current();
    };
    window.addEventListener("beforeunload", handler);
    window.addEventListener("pagehide", handler);
    document.addEventListener("visibilitychange", visHandler);
    return () => {
      window.removeEventListener("beforeunload", handler);
      window.removeEventListener("pagehide", handler);
      document.removeEventListener("visibilitychange", visHandler);
      stopRef.current();
    };
  }, []);

  (window as any).__cloudPhoneEngineRef = engineRef;

  const refreshStream = () => {
    try {
      (engineRef.current as any)?.resumeAllSubscribedStream?.(3);
    } catch (_) {}
  };

  return { status, start, stop, refreshStream };
}

export function getCloudPhoneEngine(): ArmcloudEngine | null {
  const ref = (window as any).__cloudPhoneEngineRef as { current: ArmcloudEngine | null } | undefined;
  return ref?.current ?? null;
}
