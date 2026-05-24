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
    cleanupCameraPipeline();
    const REQUIRED_CAMERA: "back" | "front" = "back";
    const existingWindowPatch = window as unknown as { __cloudPhoneOrigGetUserMedia?: typeof navigator.mediaDevices.getUserMedia };
    const getRawUserMedia = existingWindowPatch.__cloudPhoneOrigGetUserMedia ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    // Step 1: unlock device labels via a temp stream, then FULLY stop it so it doesn't
    // pin the camera into a low-res mode for the real acquisition below.
    let videoInputs: MediaDeviceInfo[] = [];
    try {
      // Open the probe at HIGH res from the start, so Android doesn't pin the
      // sensor to a low-res mode for the subsequent real acquisition.
      const temp = await getRawUserMedia({
        video: { width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      temp.getTracks().forEach((t) => {
        try { t.stop(); } catch (_) {}
      });
      // Give Android time to fully release the camera handle before re-opening.
      await new Promise((r) => setTimeout(r, 500));
      const devices = await navigator.mediaDevices.enumerateDevices();
      videoInputs = devices.filter((d) => d.kind === "videoinput");
      console.log("[CloudPhone] videoinputs:", videoInputs.map((d) => ({ label: d.label, deviceId: d.deviceId })));
    } catch (e) {
      console.warn("[CloudPhone] initial permission probe failed", e);
      setStatus("Camera permission denied");
      return;
    }

    const deviceListStr = videoInputs.map((d, i) => `  [${i}] ${d.label || "(no label)"}`).join("\n");
    const matchBack = (l: string) => {
      const s = l.toLowerCase();
      return /(back|rear|environment)/.test(s) && !/(front|user|face)/.test(s);
    };
    const matchFront = (l: string) => /(front|user|face)/.test(l.toLowerCase());
    const matcher = REQUIRED_CAMERA === "back" ? matchBack : matchFront;
    const matches = videoInputs.filter((d) => matcher(d.label));
    const preferred = matches.find((d) => /(main|\b0\b)/i.test(d.label)) ?? matches[0];

    let raw: MediaStream | null = null;
    let acquireError = "";

    if (preferred) {
      try {
        raw = await getRawUserMedia({
          video: {
            deviceId: { exact: preferred.deviceId },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
        });
      } catch (e) {
        const err = e as { name?: string; message?: string };
        acquireError = `deviceId exact failed: ${err?.name ?? "Error"}: ${err?.message ?? String(e)}`;
        console.warn("[CloudPhone]", acquireError);
        // ONE allowed retry — still strictly the required camera via facingMode exact.
        try {
          raw = await getRawUserMedia({
            video: {
              facingMode: { exact: REQUIRED_CAMERA === "back" ? "environment" : "user" },
              width: { ideal: 3840 },
              height: { ideal: 2160 },
            },
          });
        } catch (e2) {
          const err2 = e2 as { name?: string; message?: string };
          acquireError += ` | facingMode exact failed: ${err2?.name ?? "Error"}: ${err2?.message ?? String(e2)}`;
        }
      }
    } else {
      // No label match — single allowed fallback: facingMode exact for required camera only.
      try {
        raw = await getRawUserMedia({
          video: {
            facingMode: { exact: REQUIRED_CAMERA === "back" ? "environment" : "user" },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
        });
      } catch (e) {
        const err = e as { name?: string; message?: string };
        acquireError = `no label match; facingMode exact failed: ${err?.name ?? "Error"}: ${err?.message ?? String(e)}`;
      }
    }

    if (!raw) {
      const msg = `Required ${REQUIRED_CAMERA} camera not available`;
      console.warn("[CloudPhone]", msg, acquireError);
      setStatus(msg);
      return;
    }

    rawCameraRef.current = raw;
    const rawTrackInit = raw.getVideoTracks()[0];
    (rawTrackInit as MediaStreamTrack & { __cloudPhoneSource?: string }).__cloudPhoneSource = "raw-camera-for-canvas-only";

    // Push to the camera's true maximum resolution via capabilities.
    let applyErrorInfo = "";
    try {
      const caps = rawTrackInit.getCapabilities?.() ?? {};
      console.log("[CloudPhone] track capabilities (full):", JSON.stringify(caps, null, 2));
      console.log("[CloudPhone] track capabilities (object):", caps);
      const maxW = caps.width?.max;
      const maxH = caps.height?.max;
      if (maxW && maxH) {
        try {
          await rawTrackInit.applyConstraints({
            width: { ideal: maxW },
            height: { ideal: maxH },
          });
        } catch (e) {
          const err = e as { name?: string; message?: string };
          applyErrorInfo = `applyConstraints failed: ${err?.name ?? "Error"}: ${err?.message ?? String(e)}`;
          console.warn("[CloudPhone]", applyErrorInfo);
        }
      }
    } catch (e) {
      console.warn("[CloudPhone] getCapabilities failed", e);
    }

    const settings = rawTrackInit?.getSettings();
    console.log("[CloudPhone] track settings (final):", JSON.stringify(settings, null, 2));
    console.log("[CloudPhone] track settings (object):", settings);
    const finalW = settings?.width ?? 0;
    const finalH = settings?.height ?? 0;
    const lowRes = finalW > 0 && finalW < 1280;
    if (lowRes) {
      setStatus(`Low camera resolution: ${finalW}×${finalH} (hardware max)`);
    }
    console.log(
      `[CloudPhone] Camera acquired: ${REQUIRED_CAMERA} | ${rawTrackInit?.label ?? "(no label)"} | ` +
      `${finalW || "?"}×${finalH || "?"} | facingMode=${settings?.facingMode ?? "?"}`
    );


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

    // Kick off play() inside the user-gesture-rooted call stack. Don't await yet,
    // so awaiting doesn't break the gesture on mobile.
    let playError: string | null = null;
    const playPromise = video.play().catch((e) => {
      playError = e instanceof Error ? e.message : String(e);
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
    // Mobile browsers (esp. iOS Safari) require canvas in DOM AND composited at real size
    // for captureStream to keep emitting frames. Push off-screen at full size — never
    // use display:none, visibility:hidden, 1px size, or opacity:0.
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

    // Paint one frame BEFORE captureStream so the captured track has content immediately.
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

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
        if ((REQUIRED_CAMERA as string) === "front") {
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
        }
        try {
          ctx.drawImage(video, dx, dy, dw, dh);
        } catch (e) {
          console.warn("[CloudPhone] drawImage failed", e);
        }
        ctx.restore();
      }
      drawRafRef.current = requestAnimationFrame(draw);
    };
    draw();

    const portrait = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(30);
    console.log("[CloudPhone] captureStream called on canvas; same as draw canvas?", (window as any).__cloudPhoneDrawCanvas === canvas);
    (portrait as MediaStream & { __cloudPhoneSource?: string }).__cloudPhoneSource = "canvas-captureStream";
    const portraitTrack = portrait.getVideoTracks()[0];
    (portraitTrack as MediaStreamTrack & { __cloudPhoneSource?: string }).__cloudPhoneSource = "canvas-captureStream";
    canvasCameraRef.current = portrait;
    const cs = portraitTrack?.getSettings();
    console.log("[CloudPhone] canvas capture settings:", cs);

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
        const injectedSettings = canvasTrack.getSettings();
        console.log("[CloudPhone] SDK getUserMedia intercepted; returning CANVAS captureStream", {
          constraints,
          source: "canvas-captureStream",
          settings: injectedSettings,
        });
        setStatus("Camera active");
        return sdkStream;
      };
      w.__cloudPhoneGumPatchVersion = "canvas-v4-visible";
    }

    if (!w.__cloudPhoneAddTrackPatched && typeof window.RTCPeerConnection?.prototype?.addTrack === "function") {
      w.__cloudPhoneOrigAddTrack = RTCPeerConnection.prototype.addTrack;
      RTCPeerConnection.prototype.addTrack = function patchedAddTrack(track: MediaStreamTrack, ...streams: MediaStream[]) {
        const source = (track as MediaStreamTrack & { __cloudPhoneSource?: string }).__cloudPhoneSource ?? "unknown";
        const settings = track.getSettings?.();
        console.log("[CloudPhone] RTCPeerConnection.addTrack", { kind: track.kind, source, settings });
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
        videoStream: { resolution: 17, frameRate: 6, bitrate: 11 },
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
            return;
          }
          try {
            await (engineRef.current as any).setStreamConfig({ definitionId: 17, framerateId: 6, bitrateId: 11 });
            console.log("[CloudPhone] setStreamConfig applied: def=17 fr=6 br=11 (FHD-Max)");
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            setStatus("setStreamConfig error: " + m);
          }
          try {
            await (engineRef.current as any).setScreenResolution({ width: 1080, height: 1920, dpi: 480, type: 'updateDensity' });
            console.log("[CloudPhone] setScreenResolution applied: 1080x1920 @480dpi");
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
          {([
            { label: "Sharp-5fps", definitionId: 17, framerateId: 6, bitrateId: 11 },
            { label: "Motion-10fps", definitionId: 17, framerateId: 7, bitrateId: 11 },
            { label: "Motion-15fps", definitionId: 17, framerateId: 8, bitrateId: 11 },
            { label: "Balanced-720", definitionId: 15, framerateId: 8, bitrateId: 8 },
          ] as const).map((cfg) => (
            <button
              key={cfg.label}
              onClick={async () => {
                if (!engineRef.current) {
                  setStatus("No engine");
                  return;
                }
                const desc = `def=${cfg.definitionId} fr=${cfg.framerateId} br=${cfg.bitrateId}`;
                try {
                  await (engineRef.current as any).setStreamConfig({ definitionId: cfg.definitionId, framerateId: cfg.framerateId, bitrateId: cfg.bitrateId });
                  setStatus(`setStreamConfig OK: ${cfg.label} (${desc})`);
                } catch (e) {
                  const m = e instanceof Error ? e.message : String(e);
                  setStatus(`setStreamConfig ${cfg.label} (${desc}) error: ${m}`);
                }
              }}
              className="rounded-md border border-input bg-background px-3 py-2 text-xs font-medium hover:bg-accent"
            >
              {cfg.label}
            </button>
          ))}
        </div>

        <pre className="w-full whitespace-pre-wrap break-all text-left text-xs text-muted-foreground">
          {status}
        </pre>

      </div>
    </div>
  );
}
