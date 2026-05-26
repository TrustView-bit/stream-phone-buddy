import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/rec-admin")({
  head: () => ({
    meta: [
      { title: "Recording Admin" },
      { name: "description", content: "Manage recording links and view submissions." },
    ],
  }),
  component: RecAdmin,
});

interface RecLink {
  id: string;
  label: string;
  created_at: string;
}

interface FileItem {
  name: string;
  url: string;
  size: number;
  created_at: string;
}

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || Math.random().toString(36).slice(2, 8)
  );
}

function RecAdmin() {
  const [links, setLinks] = useState<RecLink[]>([]);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await (supabase as any)
      .from("recording_links")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) console.error(error);
    setLinks((data as RecLink[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    setCreating(true);
    const id = `${slugify(label)}-${Math.random().toString(36).slice(2, 6)}`;
    const { error } = await (supabase as any)
      .from("recording_links")
      .insert({ id, label: label.trim() });
    if (error) {
      alert("Error: " + error.message);
    } else {
      setLabel("");
      await load();
    }
    setCreating(false);
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this link? (Recordings will remain in storage.)")) return;
    const { error } = await (supabase as any).from("recording_links").delete().eq("id", id);
    if (error) alert(error.message);
    else load();
  };

  const openSubmissions = async (id: string) => {
    setSelected(id);
    setFilesLoading(true);
    setFiles([]);
    const { data, error } = await supabase.storage.from("recordings").list(id, {
      limit: 200,
      sortBy: { column: "created_at", order: "desc" },
    });
    if (error) {
      console.error(error);
      setFilesLoading(false);
      return;
    }
    const items: FileItem[] = (data || [])
      .filter((f) => f.name && !f.name.startsWith("."))
      .map((f) => {
        const path = `${id}/${f.name}`;
        const { data: pub } = supabase.storage.from("recordings").getPublicUrl(path);
        return {
          name: f.name,
          url: pub.publicUrl,
          size: (f.metadata as any)?.size || 0,
          created_at: (f as any).created_at || "",
        };
      });
    setFiles(items);
    setFilesLoading(false);
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-4 py-10">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Recording Admin</h1>
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Home
          </Link>
        </div>

        <form
          onSubmit={create}
          className="mb-8 flex gap-2 rounded-lg border border-border bg-card p-4"
        >
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. Customer Demo)"
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={creating || !label.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create link"}
          </button>
        </form>

        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Recording links
        </h2>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : links.length === 0 ? (
          <p className="text-sm text-muted-foreground">No links yet.</p>
        ) : (
          <ul className="space-y-2">
            {links.map((l) => {
              const url = `${origin}/rec/${l.id}`;
              return (
                <li
                  key={l.id}
                  className="rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-medium">{l.label}</div>
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        {url}
                      </a>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => navigator.clipboard.writeText(url)}
                        className="rounded-md border border-input px-3 py-1 text-xs"
                      >
                        Copy
                      </button>
                      <button
                        onClick={() => openSubmissions(l.id)}
                        className="rounded-md bg-secondary px-3 py-1 text-xs"
                      >
                        Submissions
                      </button>
                      <button
                        onClick={() => remove(l.id)}
                        className="rounded-md border border-destructive px-3 py-1 text-xs text-destructive"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {selected === l.id && (
                    <div className="mt-4 border-t border-border pt-4">
                      {filesLoading ? (
                        <p className="text-xs text-muted-foreground">Loading…</p>
                      ) : files.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No recordings submitted yet.
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {files.map((f) => (
                            <li
                              key={f.name}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background p-2 text-xs"
                            >
                              <div>
                                <div className="font-mono">{f.name}</div>
                                <div className="text-muted-foreground">
                                  {(f.size / (1024 * 1024)).toFixed(2)} MB
                                </div>
                              </div>
                              <div className="flex gap-2">
                                <a
                                  href={f.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="rounded-md border border-input px-3 py-1"
                                >
                                  Open
                                </a>
                                <a
                                  href={f.url}
                                  download={f.name}
                                  className="rounded-md bg-primary px-3 py-1 text-primary-foreground"
                                >
                                  Download
                                </a>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
