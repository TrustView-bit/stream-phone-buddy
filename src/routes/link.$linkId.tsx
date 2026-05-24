import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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

interface LinkConfig {
  label: string;
  pad_code: string;
  camera_mode: CameraMode;
  backQuality: QualityProfile;
  frontQuality: QualityProfile;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; config: LinkConfig };

function LinkPage() {
  const { linkId } = Route.useParams();
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase
          .from("links")
          .select(
            "label, pad_code, camera_mode, back_definition_id, back_framerate_id, back_bitrate_id, front_definition_id, front_framerate_id, front_bitrate_id",
          )
          .eq("id", linkId)
          .maybeSingle();
        if (error) {
          setLoad({ kind: "error", message: error.message });
          return;
        }
        if (!data) {
          setLoad({ kind: "not_found" });
          return;
        }
        setLoad({
          kind: "ready",
          config: {
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
          },
        });
      } catch (e) {
        setLoad({ kind: "error", message: String(e) });
      }
    })();
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

  return <LiveLink config={load.config} />;
}

function LiveLink({ config }: { config: LinkConfig }) {
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

  const [started, setStarted] = useState(false);

  const friendly = friendlyStatus(status);

  const onStart = async () => {
    setStarted(true);
    await start();
  };

  const onStop = () => {
    stop();
    setStarted(false);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 px-4 py-10">
        <h1 className="text-center text-2xl font-semibold tracking-tight">
          {config.label}
        </h1>
        <p className="text-center text-sm text-muted-foreground">
          This page uses your camera and streams it to a remote device.
        </p>

        <div
          id="phoneBox"
          className="aspect-[9/16] w-full max-w-[360px] overflow-hidden rounded-xl bg-muted shadow-lg"
        />

        <div className="flex items-center gap-3">
          {!started ? (
            <button
              onClick={onStart}
              className="rounded-md bg-primary px-8 py-3 text-base font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Start
            </button>
          ) : (
            <button
              onClick={onStop}
              className="rounded-md border border-input bg-background px-6 py-2 text-sm font-medium transition-colors hover:bg-accent"
            >
              Stop
            </button>
          )}
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
  if (s === "idle") return "";
  if (s.startsWith("connected")) return "Live";
  if (
    s.includes("requesting token") ||
    s.includes("releasing") ||
    s.includes("init") ||
    s.includes("switching") ||
    s.includes("camera active") ||
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

function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
        {children}
      </div>
    </div>
  );
}
