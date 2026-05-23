import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

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
        </div>

        <p className="text-sm text-muted-foreground">{status}</p>
      </div>
    </div>
  );
}
