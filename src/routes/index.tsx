import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
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
  const engineRef = useRef<any>(null);

  const startCloudPhone = async () => {
    setStatus("Requesting token…");
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
        videoStream: { resolution: 12, frameRate: 8, bitrate: 1 },
      },
      callbacks: {
        onInit: async ({ code }: { code: number | string }) => {
          if (code !== 0) {
            setStatus("Init failed: " + code);
            return;
          }
          if (!(await engineRef.current.isSupported())) {
            setStatus("This browser does not support WebRTC");
            return;
          }
          engineRef.current.start();
        },
        onConnectSuccess: () => setStatus("Connected"),
        onConnectFail: ({ msg }: { msg?: string }) => setStatus("Connect failed: " + msg),
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
    if (engineRef.current) {
      engineRef.current.stop();
      engineRef.current = null;
      setStatus("Idle");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-4 py-8">
        <h1 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
          Cloud Phone Viewer
        </h1>

        <div
          id="phoneBox"
          className="w-full overflow-hidden rounded-xl bg-neutral-800 shadow-lg"
          style={{ aspectRatio: "9 / 16", maxHeight: "80vh" }}
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
        </div>

        <pre className="w-full whitespace-pre-wrap break-all text-left text-xs text-muted-foreground">{status}</pre>
      </div>
    </div>
  );
}
