import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useCloudPhone, type CameraMode, type QualityProfile } from "@/hooks/useCloudPhone";
import { supabase } from "@/integrations/supabase/client";
import { beaconResetSession } from "@/lib/sessionBeacon";

export const Route = createFileRoute("/link/$linkId")({
  head: () => ({
    meta: [
      { title: "Camera link" },
      { name: "description", content: "Share your camera with a remote device." },
    ],
  }),
  component: LinkPage,
});

type SessionStatus = "idle" | "preparing" | "ready_for_user" | "injecting" | "live";

interface LinkConfig {
  label: string;
  pad_code: string;
  camera_mode: CameraMode;
  backQuality: QualityProfile;
  frontQuality: QualityProfile;
  session_status: SessionStatus;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; config: LinkConfig };

function LinkPage() {
  const { linkId } = Route.useParams();
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("idle");
  const [realtimeState, setRealtimeState] = useState<string>("CONNECTING");
  const [lastSource, setLastSource] = useState<string>("init");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("links")
        .select(
          "label, pad_code, camera_mode, back_definition_id, back_framerate_id, back_bitrate_id, front_definition_id, front_framerate_id, front_bitrate_id, session_status",
        )
        .eq("id", linkId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setLoad({ kind: "error", message: error.message });
        return;
      }
      if (!data) {
        setLoad({ kind: "not_found" });
        return;
      }
      const cfg: LinkConfig = {
        label: data.label,
        pad_code: data.pad_code,
        camera_mode: (data.camera_mode as CameraMode) ?? "dynamic",
        backQuality: {
          definitionId: data.back_definition_id ?? 17,
          framerateId: data.back_framerate_id ?? 6,
          bitrateId: data.back_bitrate_id ?? 11,
        },
        frontQuality: {
          definitionId: data.front_definition_id ?? 15,
          framerateId: data.front_framerate_id ?? 8,
          bitrateId: data.front_bitrate_id ?? 8,
        },
        session_status: ((data as any).session_status as SessionStatus) ?? "idle",
      };
      setLoad({ kind: "ready", config: cfg });
      setSessionStatus(cfg.session_status);
      setLastSource("initial-fetch");
    })();
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  // Subscribe to realtime updates of the link's session_status
  useEffect(() => {
    const filter = `id=eq.${linkId}`;
    setRealtimeState("CONNECTING");
    const channel = supabase
      .channel(`link-session-${linkId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "links", filter },
        (payload) => {
          console.log("[LinkPage] realtime links UPDATE received", {
            linkId,
            filter,
            oldStatus: (payload.old as any)?.session_status,
            newStatus: (payload.new as any)?.session_status,
            payload,
          });
          const next = (payload.new as any)?.session_status as SessionStatus | undefined;
          if (next) {
            setSessionStatus(next);
            setLastSource("realtime");
          }
        },
      )
      .subscribe((status, error) => {
        console.log("[LinkPage] realtime subscription status", { linkId, filter, status, error });
        setRealtimeState(error ? `ERROR: ${error.message ?? error}` : status);
      });
    return () => {
      supabase.removeChannel(channel);
      setRealtimeState("CLOSED");
    };
  }, [linkId]);

  // Polling fallback — every 2s re-fetch session_status so we never get
  // stuck if a realtime event is missed.
  useEffect(() => {
    if (load.kind !== "ready") return;
    const tick = async () => {
      const { data, error } = await supabase
        .from("links")
        .select("session_status")
        .eq("id", linkId)
        .maybeSingle();
      if (error) {
        console.warn("[LinkPage] poll error", error);
        return;
      }
      const next = (data as any)?.session_status as SessionStatus | undefined;
      if (!next) return;
      setSessionStatus((cur) => {
        if (cur !== next) {
          console.log("[LinkPage] poll detected status change", { from: cur, to: next });
          setLastSource("poll");
        }
        return next;
      });
    };
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [linkId, load.kind]);

  if (load.kind === "loading") {
    return (
      <CenteredShell>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </CenteredShell>
    );
  }
  if (load.kind === "not_found") {
    return (
      <CenteredShell>
        <h1 className="text-2xl font-semibold tracking-tight">Invalid or expired link</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This link is no longer available. Please request a new one.
        </p>
      </CenteredShell>
    );
  }
  if (load.kind === "error") {
    return (
      <CenteredShell>
        <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{load.message}</p>
      </CenteredShell>
    );
  }

  return (
    <>
      <LiveLink linkId={linkId} config={load.config} sessionStatus={sessionStatus} />
      <DebugBar sessionStatus={sessionStatus} realtimeState={realtimeState} lastSource={lastSource} />
    </>
  );
}

function DebugBar({
  sessionStatus,
  realtimeState,
  lastSource,
}: {
  sessionStatus: string;
  realtimeState: string;
  lastSource: string;
}) {
  const rtTone =
    realtimeState === "SUBSCRIBED"
      ? "text-emerald-400"
      : realtimeState.startsWith("ERROR")
      ? "text-red-400"
      : "text-amber-400";
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 bg-black/80 px-3 py-1.5 text-center font-mono text-[11px] text-white">
      status: <span className="font-semibold">{sessionStatus}</span>
      {" · "}rt: <span className={`font-semibold ${rtTone}`}>{realtimeState}</span>
      {" · "}src: <span className="font-semibold">{lastSource}</span>
    </div>
  );
}

function LiveLink({
  linkId,
  config,
  sessionStatus,
}: {
  linkId: string;
  config: LinkConfig;
  sessionStatus: SessionStatus;
}) {
  const initialRequired: "back" | "front" =
    config.camera_mode === "locked_front" ? "front" :
    config.camera_mode === "locked_back" ? "back" :
    "back";

  const { status, start, stop } = useCloudPhone({
    mode: "injector",
    cameraMode: config.camera_mode,
    requiredCamera: initialRequired,
    padCode: config.pad_code,
    viewId: "phoneBox",
    backQuality: config.backQuality,
    frontQuality: config.frontQuality,
  });

  const startedRef = useRef(false);
  const injectionMarkedRef = useRef(false);
  // Stable reference to stop() so effects don't re-fire (and cleanup) just
  // because the hook re-rendered and produced a new closure.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const sessionStatusRef = useRef(sessionStatus);
  sessionStatusRef.current = sessionStatus;

  // Auto-connect once status becomes ready_for_user
  useEffect(() => {
    if (sessionStatus !== "ready_for_user") return;
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [sessionStatus, start]);

  // When admin resets the session, tear down any active connection and
  // return to the waiting screen so we can re-start on next ready_for_user.
  useEffect(() => {
    if (sessionStatus !== "idle" && sessionStatus !== "preparing") return;
    if (!startedRef.current && !injectionMarkedRef.current) return;
    console.log("[LinkPage] session reset detected, stopping cloud phone", { sessionStatus });
    try { stopRef.current(); } catch (e) { console.warn("[LinkPage] stop threw", e); }
    startedRef.current = false;
    injectionMarkedRef.current = false;
  }, [sessionStatus]);

  // When injection succeeds (cloudphone status shows camera active/live),
  // mark session_status = 'injecting' and write user-agent + timestamp.
  useEffect(() => {
    if (injectionMarkedRef.current) return;
    const s = status.toLowerCase();
    const injected =
      s === "camera active" ||
      s.startsWith("connected · camera:") ||
      s.startsWith("connected · camera");
    if (!injected) return;
    injectionMarkedRef.current = true;
    (async () => {
      const result = await supabase
        .from("links")
        .update({
          session_status: "injecting",
          session_user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
          session_connected_at: new Date().toISOString(),
          session_updated_at: new Date().toISOString(),
        } as any)
        .eq("id", linkId);
      if (result.error) {
        console.error("[LinkPage] session_status update failed", {
          linkId,
          status: "injecting",
          error: result.error,
        });
      } else {
        console.log("[LinkPage] session_status update succeeded", {
          linkId,
          status: "injecting",
        });
      }
    })();
  }, [status, linkId]);

  // On unload / unmount, free the session so the admin doesn't stay stuck.
  // IMPORTANT: depends only on linkId — depending on `stop` would re-fire
  // cleanup on every hook re-render and incorrectly reset the session to
  // 'idle' (e.g. clobbering 'ready_for_user' right after admin pressed Ready).
  useEffect(() => {
    const reset = (reason: string) => {
      if (!startedRef.current && !injectionMarkedRef.current) {
        console.log("[LinkPage] reset skipped — nothing started", { reason, linkId });
        return;
      }
      console.log("[LinkPage] releasing session on leave -> idle", {
        reason,
        linkId,
        sessionStatus: sessionStatusRef.current,
      });
      beaconResetSession(linkId, `user-leave:${reason}`);
      try { stopRef.current(); } catch (_) {}
    };
    const onPageHide = () => reset("pagehide");
    const onBeforeUnload = () => reset("beforeunload");
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      reset("unmount");
    };
  }, [linkId]);

  // Pre-connect waiting screen
  if (sessionStatus === "idle" || sessionStatus === "preparing") {
    return (
      <CenteredShell>
        <h1 className="text-xl font-semibold tracking-tight">{config.label}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Please wait, preparing your session…
        </p>
        <Spinner />
      </CenteredShell>
    );
  }

  const friendly = friendlyStatus(status);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 px-4 py-10">
        <h1 className="text-center text-2xl font-semibold tracking-tight">{config.label}</h1>
        <p className="text-center text-sm text-muted-foreground">
          This page uses your camera and streams it to a remote device.
        </p>

        <div
          id="phoneBox"
          className="aspect-[9/16] w-full max-w-[360px] overflow-hidden rounded-xl bg-muted shadow-lg"
        />

        <div className="flex items-center gap-3">
          <button
            id="playBtn"
            hidden
            className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground"
          >
            Tap to play
          </button>
        </div>

        <p className="text-sm text-muted-foreground">{friendly}</p>
      </div>
    </div>
  );
}

function friendlyStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (s === "idle") return "Connecting…";
  if (s.startsWith("connected")) return "Live";
  if (s.includes("camera active")) return "Live";
  if (
    s.includes("requesting token") ||
    s.includes("releasing") ||
    s.includes("init") ||
    s.includes("switching") ||
    s.includes("camera switched")
  ) {
    return "Connecting…";
  }
  if (
    s.includes("error") ||
    s.includes("failed") ||
    s.includes("denied") ||
    s.includes("not available") ||
    s.includes("unavailable")
  ) {
    return "Something went wrong. Please try again.";
  }
  return "Connecting…";
}

function Spinner() {
  return (
    <div className="mt-6 h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
  );
}

function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
        {children}
      </div>
    </div>
  );
}
