import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Admin — Cloud Phone Viewer" },
      { name: "description", content: "Settings for Cloud Phone Viewer." },
    ],
  }),
  component: Admin,
});

function Admin() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-3xl font-bold tracking-tight">Admin</h1>
        <p className="mt-2 text-sm text-muted-foreground">Settings coming soon.</p>
      </div>
    </div>
  );
}
