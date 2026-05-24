import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useCloudPhone } from "@/hooks/useCloudPhone";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/view/$linkId")({
  head: () => ({
    meta: [
      { title: "View Live — Admin" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ViewPage,
});

function ViewPage() {
  const { linkId } = Route.useParams();
  const [padCode, setPadCode] = useState<string | null>(null);
  const [label, setLabel] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("links")
        .select("label, pad_code")
        .eq("id", linkId)
        .maybeSingle();
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
    })();
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
  return <Viewer padCode={padCode} label={label} />;
}

function Viewer({ padCode, label }: { padCode: string; label: string }) {
  const { status, start, stop } = useCloudPhone({
    mode: "viewer",
    padCode,
    viewId: "phoneBox",
  });
  const [started, setStarted] = useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-8">
        <h1 className="text-xl font-semibold tracking-tight">Live view: {label}</h1>
        <p className="text-xs text-muted-foreground">
          Viewer mode — no camera is being shared from this device.
        </p>
        <div
          id="phoneBox"
          className="aspect-[9/16] w-full max-w-[360px] overflow-hidden rounded-xl bg-muted shadow-lg"
        />
        <div className="flex gap-3">
          {!started ? (
            <button
              onClick={async () => {
                setStarted(true);
                await start();
              }}
              className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Connect
            </button>
          ) : (
            <button
              onClick={() => {
                stop();
                setStarted(false);
              }}
              className="rounded-md border border-input bg-background px-6 py-2 text-sm font-medium hover:bg-accent"
            >
              Disconnect
            </button>
          )}
          <button id="playBtn" hidden className="rounded-md bg-primary px-6 py-2 text-sm">
            Tap to play
          </button>
        </div>
        <p className="text-xs text-muted-foreground">{status}</p>
      </div>
    </div>
  );
}
