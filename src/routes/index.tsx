import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
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

function Index() {
  const [status, setStatus] = useState("Idle");

  const handleStart = () => {
    console.log("Start pressed");
    setStatus("Starting...");
  };

  const handleStop = () => {
    console.log("Stop pressed");
    setStatus("Idle");
  };

  const handlePlay = () => {
    console.log("Play pressed");
  };

  const handleTestToken = async () => {
    setStatus("Calling cloudphone-token...");
    const { data, error } = await supabase.functions.invoke("cloudphone-token");
    if (error) {
      setStatus(`Error: ${error.message}`);
      return;
    }
    setStatus(JSON.stringify(data, null, 2));
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
            onClick={handleStart}
            className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Start
          </button>
          <button
            onClick={handleStop}
            className="rounded-md border border-input bg-background px-6 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Stop
          </button>
          <button
            id="playBtn"
            onClick={handlePlay}
            hidden
            className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground"
          >
            Tap to play
          </button>
          <button
            onClick={handleTestToken}
            className="rounded-md border border-input bg-background px-6 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Test token function
          </button>
        </div>

        <pre className="w-full whitespace-pre-wrap break-all text-left text-xs text-muted-foreground">{status}</pre>
      </div>
    </div>
  );
}
