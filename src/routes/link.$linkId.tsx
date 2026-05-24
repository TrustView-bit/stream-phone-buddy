import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useCloudPhone, type CameraMode, type QualityProfile } from "@/hooks/useCloudPhone";
import { supabase } from "@/integrations/supabase/client";

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
type StatusSource = "init" | "realtime" | "poll";

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
  const [statusSource, setStatusSource] = useState<StatusSource>("init");
  const [rtStatus, setRtStatus] = useState<string>("connecting");

  // Initial fetch of link config + current session_status
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
      setStatusSource("init");
    })();
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  // Realtime subscription to session_status changes
  useEffect(() => {
    const filter = `id=eq.${linkId}`;
    const channel = supabase
      .channel(`link-session-${linkId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "links", filter },
        (payload) => {
          const next = (payload.new as any)?.session_status as SessionStatus | undefined;
          console.log("[LinkPage] realtime UPDATE", {
            linkId,
            oldStatus: (payload.old as any)?.session_status,
            newStatus: next,
          });
          if (next) {
            setSessionStatus(next);
            setStatusSource("realtime");
          }
        },
      )
      .subscribe((status, error) => {
        console.log("[LinkPage] realtime subscription", { linkId, status, error });
        setRtStatus(String(status).toLowerCase());
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [linkId]);

  // 2-second polling fallback (reliability net if realtime drops events)
  useEffect(() => {
    let cancelled = false;
    const id = setInterval(async () => {
      const { data, error } = await supabase
        .from("links")
        .select("session_status")
        .eq("id", linkId)
        .maybeSingle();
      if (cancelled || error || !data) return;
      const next = ((data as any).session_status as SessionStatus) ?? "idle";
      setSessionStatus((prev) => {
        if (prev !== next) {
          console.log("[LinkPage] poll detected change", { from: prev, to: next });
          setStatusSource("poll");
        }
        return next;
      });
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [linkId]);

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
    <LiveLink
      linkId={linkId}
      config={load.config}
      sessionStatus={sessionStatus}
      statusSource={statusSource}
      rtStatus={rtStatus}
    />
  );
}

function LiveLink({
  linkId,
  config,
  sessionStatus,
  statusSource,
  rtStatus,
}: {
  linkId: string;
  config: LinkConfig;
  sessionStatus: SessionStatus;
  statusSource: StatusSource;
  rtStatus: string;
}) {
  const initialRequired: "back" | "front" =
    config.camera_mode === "locked_front" ? "front" :
    config.camera_mode === "locked_back" ? "back" :
    "back";

  const { status, start } = useCloudPhone({
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

  // 1) Auto-connect once when admin signals ready
  useEffect(() => {
    if (sessionStatus !== "ready_for_user") return;
    if (startedRef.current) return;
    startedRef.current = true;
    console.log("[LinkPage] ready_for_user → start()");
    void start();
  }, [sessionStatus, start]);

  // 2) When injection succeeds, mark session_status = 'injecting' (once)
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
        console.error("[LinkPage] mark injecting failed", result.error);
      } else {
        console.log("[LinkPage] marked session_status = injecting");
      }
    })();
  }, [status, linkId]);

  // Pre-connect waiting screen
  if (sessionStatus === "idle" || sessionStatus === "preparing") {
    return (
      <CenteredShell>
        <h1 className="text-xl font-semibold tracking-tight">{config.label}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Please wait, preparing your session…
        </p>
        <Spinner />
        <DebugBar
          sessionStatus={sessionStatus}
          rtStatus={rtStatus}
          statusSource={statusSource}
          hookStatus={status}
        />
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

        <DebugBar
          sessionStatus={sessionStatus}
          rtStatus={rtStatus}
          statusSource={statusSource}
          hookStatus={status}
        />
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

function DebugBar({
  sessionStatus,
  rtStatus,
  statusSource,
  hookStatus,
}: {
  sessionStatus: SessionStatus;
  rtStatus: string;
  statusSource: StatusSource;
  hookStatus: string;
}) {
  return (
    <div className="mt-4 w-full max-w-[360px] rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[10px] leading-tight text-muted-foreground">
      <div>status: {sessionStatus}</div>
      <div>rt: {rtStatus}</div>
      <div>src: {statusSource}</div>
      <div className="break-words">hook: {hookStatus}</div>
    </div>
  );
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
