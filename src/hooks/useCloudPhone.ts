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
  sendKey: (keyCode: number) => void;
  pauseDownstream: () => void;
  resumeDownstream: () => void;
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
  const viewerRemoteCameraEnabledRef = useRef(false);

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
    clearRecoveryTimer();
    hasConnectedRef.current = false;
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
      // Restore getUserMedia if this injector instance patched it.
      if (mode === "injector") {
        const w = window as unknown as {
          __cloudPhoneOrigGetUserMedia?: typeof navigator.mediaDevices.getUserMedia;
          __cloudPhoneGumPatchVersion?: string;
        };
        if (w.__cloudPhoneOrigGetUserMedia) {
          try {
            navigator.mediaDevices.getUserMedia = w.__cloudPhoneOrigGetUserMedia;
          } catch (_) {}
          w.__cloudPhoneGumPatchVersion = undefined;
        }
      }
    } catch (e) {
      console.warn("[CloudPhone] stop error", e);
    }
  };


  const stopRef = useRef(stop);
  stopRef.current = stop;
  const startRef = useRef<(() => Promise<void>) | null>(null);

  // Network-resilience: track whether we ever connected this cycle, and the
  // single in-flight recovery timer that grants the SDK ~20s to self-heal.
  const hasConnectedRef = useRef(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryRetryIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recoveryAttemptRef = useRef(0);
  const RECOVERY_WINDOW_MS = 30000;
  const RECOVERY_RETRY_MS = 4000;
  const clearRecoveryTimer = () => {
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    if (recoveryRetryIntervalRef.current) {
      clearInterval(recoveryRetryIntervalRef.current);
      recoveryRetryIntervalRef.current = null;
    }
    recoveryAttemptRef.current = 0;
  };
  const beginRecoveryWindow = (reason: string) => {
    if (recoveryTimerRef.current) {
      console.log("[CloudPhone] recovery already in progress, keeping timer", { reason });
      return;
    }
    console.log("[CloudPhone] entering recovery window", { reason });
    setStatus("Connection lost — reconnecting…");
    recoveryAttemptRef.current = 0;
    recoveryRetryIntervalRef.current = setInterval(() => {
      recoveryAttemptRef.current += 1;
      console.log(`[CloudPhone] active recovery attempt ${recoveryAttemptRef.current}`);
      try {
        engineRef.current?.start();
      } catch (e) {
        console.warn("[CloudPhone] active recovery start() threw", e);
      }
    }, RECOVERY_RETRY_MS);
    recoveryTimerRef.current = setTimeout(() => {
      if (recoveryRetryIntervalRef.current) {
        clearInterval(recoveryRetryIntervalRef.current);
        recoveryRetryIntervalRef.current = null;
      }
      recoveryTimerRef.current = null;
      console.warn("[CloudPhone] recovery window exhausted, stopping");
      setStatus("Connection lost.");
      stopRef.current();
    }, RECOVERY_WINDOW_MS);
  };

  /**
   * Acquire a raw camera MediaStream for the requested facing using strict
   * device-label/facingMode matching. Returns null on failure. No fallback to
   * the other camera — caller decides what to do.
   */
  const acquireCameraStream = async (facing: Facing): Promise<{ stream: MediaStream | null; error: string }> => {
    const w = window as unknown as { __cloudPhoneOrigGetUserMedia?: typeof navigator.mediaDevices.getUserMedia };
    const getRawUserMedia = w.__cloudPhoneOrigGetUserMedia ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    let videoInputs: MediaDeviceInfo[] = [];
    const enumerate = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        videoInputs = devices.filter((d) => d.kind === "videoinput");
      } catch (e) {
        console.warn("[CloudPhone] enumerateDevices failed", e);
      }
    };
    await enumerate();

    // Firefox: labels are blank until getUserMedia has been granted once.
    // Prime with a permissive call so subsequent enumerateDevices returns labels.
    const labelsBlank = videoInputs.length === 0 || videoInputs.every((d) => !d.label);
    if (labelsBlank) {
      try {
        console.log("[CloudPhone] Priming getUserMedia to unlock device labels");
        const primer = await getRawUserMedia({ video: true });
        primer.getTracks().forEach((t) => t.stop());
        await enumerate();
      } catch (e) {
        console.warn("[CloudPhone] Primer getUserMedia failed", e);
      }
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
    let lastErrName = "";

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
        lastErrName = err?.name ?? "";
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
        lastErrName = err?.name ?? "";
        error += ` | facingMode exact failed: ${err?.name ?? "Error"}: ${err?.message ?? String(e)}`;
        console.warn("[CloudPhone] facingMode exact failed", err);
      }
    }

    // Firefox-friendly: ideal facingMode (not exact)
    if (!stream) {
      try {
        stream = await getRawUserMedia({
          video: {
            facingMode: { ideal: facing === "back" ? "environment" : "user" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        console.log("[CloudPhone] Acquired via facingMode ideal fallback");
      } catch (e) {
        const err = e as { name?: string; message?: string };
        lastErrName = err?.name ?? "";
        error += ` | facingMode ideal failed: ${err?.name ?? "Error"}: ${err?.message ?? String(e)}`;
        console.warn("[CloudPhone] facingMode ideal failed", err);
      }
    }

    // Last resort: any camera
    if (!stream) {
      try {
        stream = await getRawUserMedia({ video: true });
        console.warn("[CloudPhone] Fell back to plain { video: true } — facing preference not enforced");
      } catch (e) {
        const err = e as { name?: string; message?: string };
        lastErrName = err?.name ?? "";
        error += ` | plain video failed: ${err?.name ?? "Error"}: ${err?.message ?? String(e)}`;
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
      return { stream, error: "" };
    }

    // Map error to a meaningful message
    let friendly = error;
    if (lastErrName === "NotAllowedError" || lastErrName === "SecurityError") {
      friendly = "camera permission denied";
    } else if (lastErrName === "NotFoundError" || lastErrName === "DevicesNotFoundError") {
      friendly = "no camera found on this device";
    } else if (lastErrName === "OverconstrainedError" || lastErrName === "ConstraintNotSatisfiedError") {
      friendly = "camera constraints not supported";
    } else if (lastErrName === "NotReadableError" || lastErrName === "TrackStartError") {
      friendly = "camera is in use by another app";
    }

    return { stream: null, error: friendly || error || "camera unavailable" };
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
        await Promise.resolve((engineRef.current as any)?.setStreamConfig?.(profile)).catch((e) => {
          const msg = String((e as any)?.message ?? e ?? "");
          if (/has already capture/i.test(msg)) {
            console.warn("[CloudPhone] setStreamConfig: capture already active (ignored)");
            return;
          }
          console.warn("[CloudPhone] setStreamConfig on switch failed", e);
        });
        console.log("[CloudPhone] setStreamConfig applied for", target, profile);
      } catch (e) {
        console.warn("[CloudPhone] setStreamConfig on switch threw", e);
      }
      setStatus(`Camera switched: ${target}`);
    } catch (e) {
      const msg = String((e as any)?.message ?? e ?? "");
      if (/has already capture/i.test(msg)) {
        console.warn("[CloudPhone] switchToCamera: 'Has already capture' swallowed");
      } else {
        console.warn("[CloudPhone] switchToCamera error", e);
      }
    } finally {
      switchInProgressRef.current = false;
      const pending = pendingSwitchRef.current;
      pendingSwitchRef.current = null;
      if (pending && pending !== currentFacingRef.current) {
        // Process queued request
        setTimeout(() => {
          void switchToCamera(pending).catch((e) => {
            console.warn("[CloudPhone] queued switchToCamera swallowed", e);
          });
        }, 0);
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
      // Acquire camera FIRST, within the user gesture (iOS Safari / Firefox
      // invalidate the gesture once an unrelated awaited op runs first).
      // acquireCameraStream handles the label-priming, layered facingMode
      // fallbacks, and accurate error mapping internally.
      const { stream: raw, error: acquireError } = await acquireCameraStream(initialFacing);
      if (!raw) {
        console.warn("[CloudPhone] camera acquisition failed", acquireError);
        setStatus(acquireError || `Required ${initialFacing} camera not available`);
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
    }


    if (!padCodeOverride) {
      setStatus("Missing pad code");
      return;
    }
    // Token fetch with 8s timeout and up to 2 attempts (initial + 1 retry)
    const MAX_TOKEN_ATTEMPTS = 2;
    const TOKEN_TIMEOUT_MS = 8000;
    let tokenData: { token?: string; padCode?: string } | null = null;
    let lastTokenError: string | null = null;
    for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt++) {
      const invokePromise = supabase.functions.invoke("cloudphone-token", {
        body: { padCode: padCodeOverride },
      });
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<{ __timedOut: true }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ __timedOut: true }), TOKEN_TIMEOUT_MS);
      });
      const result = await Promise.race([invokePromise, timeoutPromise]);
      if (timeoutId) clearTimeout(timeoutId);
      if ((result as { __timedOut?: boolean }).__timedOut) {
        lastTokenError = "timeout";
        console.warn("[CloudPhone] token fetch timed out (attempt " + attempt + ")");
        if (attempt < MAX_TOKEN_ATTEMPTS) {
          setStatus("Token timed out, retrying…");
          continue;
        }
        break;
      }
      const { data, error } = result as { data: { token?: string; padCode?: string } | null; error: { message: string } | null };
      if (error) {
        lastTokenError = error.message;
        console.warn("[CloudPhone] token fetch error (attempt " + attempt + ")", error);
        if (attempt < MAX_TOKEN_ATTEMPTS) {
          setStatus("Token error, retrying…");
          continue;
        }
        break;
      }
      tokenData = data;
      break;
    }
    if (!tokenData || !tokenData.token) {
      setStatus("Connection failed — please retry" + (lastTokenError ? ` (${lastTokenError})` : ""));
      return;
    }
    const token = tokenData.token;
    const padCode = padCodeOverride ?? tokenData.padCode;

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
          hasConnectedRef.current = true;
          clearRecoveryTimer();
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
          console.warn("[CloudPhone] onConnectFail", { msg, hasConnected: hasConnectedRef.current });
          if (hasConnectedRef.current) {
            // Reconnect attempt failed — let the recovery window keep trying.
            beginRecoveryWindow("onConnectFail after prior success: " + (msg ?? ""));
            return;
          }
          // Genuine initial-connection failure — surface and stop.
          setStatus("Connect failed: " + msg + " · releasing session");
          stopRef.current();
        },
        onConnectionStateChanged: (payload: { state: number }) => {
          console.log("[CloudPhone] onConnectionStateChanged", payload);
          if (payload?.state >= 4) {
            // Transient disconnect — give the SDK a recovery window before tearing down.
            beginRecoveryWindow("connectionState=" + payload.state);
          }
        },
        onErrorMessage: (payload: { msg?: string; code?: number | string }) => {
          console.warn("[CloudPhone] onErrorMessage", payload);
          // Do NOT stop on transient errors — let the recovery window / SDK auto-recovery handle it.
          setStatus("Connection issue: " + (payload?.msg ?? payload?.code ?? "unknown"));
        },
        onUserLeave: (event: { reason?: string | number }) => {
          // Genuine session end from the cloud-phone side — stop for real.
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
            if (isRefreshingRef.current) {
              if (stats?.enabled === true) viewerRemoteCameraEnabledRef.current = true;
              return;
            }
            if (stats?.enabled !== true) {
              viewerRemoteCameraEnabledRef.current = false;
              return;
            }
            if (!viewerRemoteCameraEnabledRef.current) {
              viewerRemoteCameraEnabledRef.current = true;
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
          // Ignore redundant toggles: same facing + capture already live.
          const liveTrack = rawCameraRef.current?.getVideoTracks()[0];
          if (
            currentFacingRef.current === target &&
            liveTrack?.readyState === "live"
          ) {
            return;
          }
          void switchToCamera(target).catch((e) => {
            console.warn("[CloudPhone] switchToCamera (toggle) swallowed", e);
          });
        },
        onAutoRecoveryTime: () => {
          console.log("[CloudPhone] onAutoRecoveryTime → engine.start()");
          engineRef.current?.start();
        },
      },
    });
  };
  startRef.current = start;

  useEffect(() => {
    const isInjectorMode = mode === "injector";
    const unloadHandler = () => stopRef.current();
    const visHandler = () => {
      // Only act on RETURN to foreground — never stop on hide/background.
      if (document.visibilityState !== "visible") return;
      if (!engineRef.current) return;
      console.log("[CloudPhone] tab visible — attempting graceful resume");
      try {
        if (isInjectorMode) {
          const v = hiddenVideoRef.current;
          if (v && v.paused) {
            v.play().catch((e) => console.warn("[CloudPhone] hidden video resume failed", e));
          }
        } else {
          (engineRef.current as any)?.resumeAllSubscribedStream?.(3);
        }
      } catch (e) {
        console.warn("[CloudPhone] resume error", e);
      }
    };
    window.addEventListener("beforeunload", unloadHandler);
    document.addEventListener("visibilitychange", visHandler);
    return () => {
      if (viewerAutoRefreshTimerRef.current !== null) {
        window.clearTimeout(viewerAutoRefreshTimerRef.current);
        viewerAutoRefreshTimerRef.current = null;
      }
      window.removeEventListener("beforeunload", unloadHandler);
      document.removeEventListener("visibilitychange", visHandler);
      stopRef.current();
    };
  }, [mode]);



  const refreshStream = async () => {
    if (mode === "viewer") {
      if (isRefreshingRef.current) return;
      if (viewerAutoRefreshTimerRef.current !== null) {
        window.clearTimeout(viewerAutoRefreshTimerRef.current);
        viewerAutoRefreshTimerRef.current = null;
      }
      isRefreshingRef.current = true;
      try {
        // Kick the video subscription without leaving the room.
        (engineRef.current as any)?.pauseAllSubscribedStream?.(2);
        await new Promise((r) => setTimeout(r, 400));
        (engineRef.current as any)?.resumeAllSubscribedStream?.(2);
      } catch (e) {
        console.warn("[CloudPhone] viewer refresh failed", e);
      } finally {
        isRefreshingRef.current = false;
      }
      return;
    }
    try {
      (engineRef.current as any)?.resumeAllSubscribedStream?.(3);
    } catch (_) {}
  };


  const sendKey = (keyCode: number) => {
    try {
      (engineRef.current as any)?.triggerKeyboardShortcut?.(0, keyCode);
    } catch (e) {
      console.warn("[CloudPhone] sendKey failed", keyCode, e);
    }
  };

  const pauseDownstream = () => {
    try {
      console.log("[CloudPhone] pauseDownstream() — pausing subscribed video (mediaType 2)");
      (engineRef.current as any)?.pauseAllSubscribedStream?.(2);
    } catch (e) {
      console.warn("[CloudPhone] pauseDownstream failed", e);
    }
  };

  const resumeDownstream = () => {
    try {
      console.log("[CloudPhone] resumeDownstream() — resuming subscribed video (mediaType 2)");
      (engineRef.current as any)?.resumeAllSubscribedStream?.(2);
    } catch (e) {
      console.warn("[CloudPhone] resumeDownstream failed", e);
    }
  };

  return { status, start, stop, refreshStream, sendKey, pauseDownstream, resumeDownstream };
}

