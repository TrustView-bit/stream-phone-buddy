import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useCloudPhone, type CameraMode, type QualityProfile } from "@/hooks/useCloudPhone";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Cloud Phone Viewer" },
      { name: "description", content: "Stream your webcam into a remote Android phone." },
    ],
  }),
  component: Index,
});

interface AppSettings {
  camera_mode: CameraMode;
  required_camera: "back" | "front";
  pad_code: string | null;
  backQuality: QualityProfile;
  frontQuality: QualityProfile;
}

const DEFAULT_SETTINGS: AppSettings = {
  camera_mode: "dynamic",
  required_camera: "back",
  pad_code: null,
  backQuality: { definitionId: 17, framerateId: 6, bitrateId: 11 },
  frontQuality: { definitionId: 15, framerateId: 8, bitrateId: 8 },
};

function Index() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase
          .from("app_settings")
          .select(
            "camera_mode, required_camera, pad_code, back_definition_id, back_framerate_id, back_bitrate_id, front_definition_id, front_framerate_id, front_bitrate_id",
          )
          .eq("id", "default")
          .maybeSingle();
        if (error) throw error;
        if (data) {
          setSettings({
            camera_mode: (data.camera_mode as CameraMode) ?? "dynamic",
            required_camera: (data.required_camera as "back" | "front") ?? "back",
            pad_code: data.pad_code,
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
          });
        }
      } catch (e) {
        console.warn("[Index] settings fetch failed, using defaults", e);
      } finally {
        setSettingsLoaded(true);
      }
    })();
  }, []);

  const initialRequiredCamera: "back" | "front" =
    settings.camera_mode === "locked_front" ? "front" :
    settings.camera_mode === "locked_back" ? "back" :
    settings.required_camera;

  const { status, start, stop } = useCloudPhone({
    mode: "injector",
    cameraMode: settings.camera_mode,
    requiredCamera: initialRequiredCamera,
    padCode: settings.pad_code ?? undefined,
    viewId: "phoneBox",
    backQuality: settings.backQuality,
    frontQuality: settings.frontQuality,
  });

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
            onClick={start}
            disabled={!settingsLoaded}
            className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            Start
          </button>
          <button
            onClick={stop}
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
      </div>
    </div>
  );
}
