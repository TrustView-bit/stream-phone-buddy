import { createFileRoute } from "@tanstack/react-router";
import { useCloudPhone, getCloudPhoneEngine } from "@/hooks/useCloudPhone";

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
  const { status, start, stop } = useCloudPhone({
    mode: "injector",
    requiredCamera: "back",
    viewId: "phoneBox",
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
            className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
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
          {([
            { label: "Sharp-5fps", definitionId: 17, framerateId: 6, bitrateId: 11 },
            { label: "Motion-10fps", definitionId: 17, framerateId: 7, bitrateId: 11 },
            { label: "Motion-15fps", definitionId: 17, framerateId: 8, bitrateId: 11 },
            { label: "Balanced-720", definitionId: 15, framerateId: 8, bitrateId: 8 },
          ] as const).map((cfg) => (
            <button
              key={cfg.label}
              onClick={async () => {
                const engine = getCloudPhoneEngine();
                if (!engine) return;
                try {
                  await (engine as any).setStreamConfig({ definitionId: cfg.definitionId, framerateId: cfg.framerateId, bitrateId: cfg.bitrateId });
                } catch (e) {
                  console.warn("setStreamConfig error", e);
                }
              }}
              className="rounded-md border border-input bg-background px-3 py-2 text-xs font-medium hover:bg-accent"
            >
              {cfg.label}
            </button>
          ))}
        </div>

        <pre className="w-full whitespace-pre-wrap break-all text-left text-xs text-muted-foreground">
          {status}
        </pre>
      </div>
    </div>
  );
}
