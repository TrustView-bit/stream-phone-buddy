import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Cloud Phone Viewer" },
      { name: "description", content: "Manage and share phone links." },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-20 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Cloud Phone Viewer</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This service is accessed via per-phone links.
        </p>
        <div className="mt-8 flex gap-3">
          <Link
            to="/admin"
            className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Open admin
          </Link>
          <Link
            to="/rec-admin"
            className="rounded-md border border-input bg-background px-6 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Recording admin
          </Link>
        </div>
      </div>
    </div>
  );
}
