import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useCloudPhone } from "@/hooks/useCloudPhone";
import { supabase } from "@/integrations/supabase/client";
import { beaconResetSession } from "@/lib/sessionBeacon";

export const Route = createFileRoute("/view/$linkId")({
  head: () => ({
    meta: [
      { title: "View Live — Admin" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ViewPage,
});

type SessionStatus = "idle" | "preparing" | "ready_for_user" | "injecting" | "live";

interface SessionRow {
  status: SessionStatus;
  userAgent: string | null;
  connectedAt: string | null;
}

function ViewPage() {
  const { linkId } = Route.useParams();
  const [padCode, setPadCode] = useState<string | null>(null);
  const [label, setLabel] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [session, setSession] = useState<SessionRow>({
    status: "idle",
    userAgent: null,
    connectedAt: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("links")
        .select("label, pad_code, session_status, session_user_agent, session_connected_at")
        .eq("id", linkId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setError(error.message);
        return;
      }
      if (!data) {
        setError("Link not found");
        return;
      }
      setLabel(data.label);
      setPadCode(data.pad_code);
      setSession({
        status: (((data as any).session_status as SessionStatus) ?? "idle"),
        userAgent: (data as any).session_user_agent ?? null,
        connectedAt: (data as any).session_connected_at ?? null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  useEffect(() => {
    const filter = `id=eq.${linkId}`;
    const channel = supabase
      .channel(`view-session-${linkId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "links", filter },
        (payload) => {
          const n = payload.new as any;
          console.log("[ViewPage] realtime links UPDATE received", {
            linkId,
            filter,
            oldStatus: (payload.old as any)?.session_status,
            newStatus: n?.session_status,
            payload,
          });
          setSession({
            status: (n?.session_status as SessionStatus) ?? "idle",
            userAgent: n?.session_user_agent ?? null,
            connectedAt: n?.session_connected_at ?? null,
          });
        },
      )
      .subscribe((status, error) => {
        console.log("[ViewPage] realtime subscription status", { linkId, filter, status, error });
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [linkId]);

  if (error) {
    return (
      <div className="min-h-screen bg-background p-8 text-foreground">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  if (!padCode) {
    return (
      <div className="min-h-screen bg-background p-8 text-foreground">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }
  return <Viewer linkId={linkId} padCode={padCode} label={label} session={session} />;
}

async function updateSessionStatus(linkId: string, status: SessionStatus, extra?: Record<string, any>) {
  const result = await supabase
    .from("links")
    .update({
      session_status: status,
      session_updated_at: new Date().toISOString(),
      ...(extra ?? {}),
    } as any)
    .eq("id", linkId);
  if (result.error) {
    console.error("[ViewPage] session_status update failed", { linkId, status, error: result.error });
    return false;
  }
  console.log("[ViewPage] session_status update succeeded", { linkId, status });
  return true;
}

function Viewer({
  linkId,
  padCode,
  label,
  session,
}: {
  linkId: string;
  padCode: string;
  label: string;
  session: SessionRow;
}) {
  const { status, start, stop, refreshStream } = useCloudPhone({
    mode: "viewer",
    padCode,
    viewId: "phoneBox",
  });
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const autoReconnectRef = useRef(false);
  const liveMarkedRef = useRef(false);
  const waitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevStatusRef = useRef<SessionStatus>(session.status);
  const selfResetRef = useRef(false);
  // True when the most recent session_status write was initiated by the
  // admin (Connect / Ready / Reset). Cleanup effects should ignore the
  // realtime echo of admin-initiated transitions.
  const adminInitiatedRef = useRef(false);
  // Hold a stable reference to stop() so effects don't re-fire just because
  // the hook re-rendered and produced a new closure.
  const stopRef = useRef(stop);
  stopRef.current = stop;

  const clearWaitTimer = () => {
    if (waitTimerRef.current) {
      clearTimeout(waitTimerRef.current);
      waitTimerRef.current = null;
    }
  };

  const cleanLocal = (reason: string) => {
    console.log("[ViewPage] cleanLocal", { reason, linkId });
    try { stopRef.current(); } catch (_) {}
    setConnected(false);
    autoReconnectRef.current = false;
    liveMarkedRef.current = false;
    clearWaitTimer();
  };

  const doConnect = async (initialStatus: SessionStatus) => {
    console.log("[ViewPage] doConnect", { initialStatus, linkId });
    adminInitiatedRef.current = true;
    setNotice("");
    setConnected(true);
    await updateSessionStatus(linkId, initialStatus);
    await start();
  };

  const doDisconnect = async (nextStatus?: SessionStatus) => {
    console.log("[ViewPage] doDisconnect", { nextStatus, linkId });
    adminInitiatedRef.current = true;
    cleanLocal("doDisconnect");
    if (nextStatus) await updateSessionStatus(linkId, nextStatus);
  };

  const onReady = async () => {
    console.log("[ViewPage] onReady — handing off to user", { linkId });
    adminInitiatedRef.current = true;
    selfResetRef.current = true;
    await updateSessionStatus(linkId, "ready_for_user");
    cleanLocal("onReady");
  };

  const onReset = async () => {
    console.log("[ViewPage] manual reset", { linkId, sessionStatus: session.status });
    adminInitiatedRef.current = true;
    selfResetRef.current = true;
    cleanLocal("onReset");
    setNotice("");
    await updateSessionStatus(linkId, "idle", {
      session_user_agent: null,
      session_connected_at: null,
    });
  };

  // Wait-timer: after 'ready_for_user', auto-reset if user never connects.
  useEffect(() => {
    console.log("[ViewPage] wait-timer effect run", { sessionStatus: session.status });
    if (session.status !== "ready_for_user") {
      clearWaitTimer();
      return;
    }
    clearWaitTimer();
    console.log("[ViewPage] starting 60s wait timer for user connect", { linkId });
    waitTimerRef.current = setTimeout(() => {
      console.log("[ViewPage] wait timer fired — user did not connect", { linkId });
      adminInitiatedRef.current = true;
      selfResetRef.current = true;
      cleanLocal("wait-timer");
      setNotice("User didn't connect — session reset. Try again.");
      void updateSessionStatus(linkId, "idle", {
        session_user_agent: null,
        session_connected_at: null,
      });
    }, 60_000);
    return clearWaitTimer;
  }, [session.status, linkId]);

  // Detect status transitions
  useEffect(() => {
    const prev = prevStatusRef.current;
    const next = session.status;
    if (prev !== next) {
      console.log("[ViewPage] transition effect", {
        prev,
        next,
        linkId,
        adminInitiated: adminInitiatedRef.current,
        selfInitiated: selfResetRef.current,
      });
    }
    // User connected -> clear wait timer & notice
    if (next === "injecting" && prev !== "injecting") {
      clearWaitTimer();
      setNotice("");
    }
    // Genuine user-side disconnect: was live/injecting, now idle, not us.
    if (
      next === "idle" &&
      (prev === "injecting" || prev === "live") &&
      !selfResetRef.current &&
      !adminInitiatedRef.current
    ) {
      console.log("[ViewPage] detected user disconnect", { prev, linkId });
      cleanLocal("user-disconnect");
      setNotice("User disconnected.");
    }
    if (next !== "idle") selfResetRef.current = false;
    // Reset admin-initiated flag once the echo of the admin's own write has
    // been processed (i.e. status has settled to the value the admin wrote).
    if (prev !== next) adminInitiatedRef.current = false;
    prevStatusRef.current = next;
  }, [session.status, linkId]);

  // When the user starts injecting, auto-reconnect admin in viewer mode (once)
  useEffect(() => {
    if (session.status !== "injecting") return;
    if (connected || autoReconnectRef.current) return;
    autoReconnectRef.current = true;
    console.log("[ViewPage] auto-reconnecting viewer after user injection", { linkId });
    void (async () => {
      setConnected(true);
      await start();
    })();
  }, [session.status, connected, start, linkId]);

  // Once viewer connection is established after injecting, mark live (once)
  useEffect(() => {
    if (liveMarkedRef.current) return;
    if (session.status !== "injecting") return;
    if (!connected) return;
    const s = status.toLowerCase();
    if (s.startsWith("connected")) {
      liveMarkedRef.current = true;
      void updateSessionStatus(linkId, "live");
    }
  }, [status, session.status, connected, linkId]);

  // On unload / unmount, free the session if we were holding it.
  // IMPORTANT: depends only on linkId — depending on `stop` would re-fire
  // cleanup on every hook re-render (status updates) and kill the session.
  useEffect(() => {
    const release = (reason: string) => {
      const s = prevStatusRef.current;
      if (s === "idle") return;
      console.log("[ViewPage] releasing session on leave", { reason, status: s, linkId });
      beaconResetSession(linkId, `admin-leave:${reason}`);
      try { stopRef.current(); } catch (_) {}
    };
    const onPageHide = () => release("pagehide");
    const onBeforeUnload = () => release("beforeunload");
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      clearWaitTimer();
      release("unmount");
    };
  }, [linkId]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-8">
        <h1 className="text-xl font-semibold tracking-tight">Live view: {label}</h1>
        <p className="text-xs text-muted-foreground">
          Viewer mode — no camera is being shared from this device.
        </p>

        <SessionBox session={session} />

        {notice && (
          <div className="w-full rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm">
            {notice}
          </div>
        )}

        <div
          id="phoneBox"
          className="aspect-[9/16] w-full max-w-[360px] overflow-hidden rounded-xl bg-muted shadow-lg"
        />

        <div className="flex flex-wrap justify-center gap-3">
          {!connected ? (
            <button
              onClick={() => void doConnect("preparing")}
              className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Connect & prepare
            </button>
          ) : (
            <>
              <button
                onClick={() => void onReady()}
                className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Ready — hand off to user
              </button>
              <button
                onClick={() => void doDisconnect()}
                className="rounded-md border border-input bg-background px-6 py-2 text-sm font-medium hover:bg-accent"
              >
                Disconnect
              </button>
              <button
                onClick={() => refreshStream()}
                className="rounded-md border border-input bg-background px-6 py-2 text-sm font-medium hover:bg-accent"
              >
                Refresh stream
              </button>
            </>
          )}
          <button
            onClick={() => void onReset()}
            className="rounded-md border border-destructive/40 bg-background px-6 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
          >
            Reset session
          </button>
          <button id="playBtn" hidden className="rounded-md bg-primary px-6 py-2 text-sm">
            Tap to play
          </button>
        </div>

        <p className="text-xs text-muted-foreground">{status}</p>
      </div>
    </div>
  );
}

function SessionBox({ session }: { session: SessionRow }) {
  const label =
    session.status === "idle" ? "Idle"
    : session.status === "preparing" ? "Preparing phone…"
    : session.status === "ready_for_user" ? "Waiting for user to connect…"
    : session.status === "injecting" ? "User connected"
    : "Live";

  const tone =
    session.status === "injecting" || session.status === "live"
      ? "border-primary/40 bg-primary/5"
      : session.status === "ready_for_user"
      ? "border-amber-500/40 bg-amber-500/5"
      : "border-border bg-muted/30";

  return (
    <div className={`w-full rounded-md border px-4 py-3 text-sm ${tone}`}>
      <div className="font-medium">Session: {label}</div>
      {(session.status === "injecting" || session.status === "live") && (
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          {session.connectedAt && (
            <div>
              Connected at:{" "}
              <span className="font-mono">{new Date(session.connectedAt).toLocaleString()}</span>
            </div>
          )}
          {session.userAgent && (
            <div className="break-words">
              User agent: <span className="font-mono">{session.userAgent}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
