import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Admin — Cloud Phone Viewer" },
      { name: "description", content: "Manage phone links." },
    ],
  }),
  component: Admin,
});

const ADMIN_PASSWORD = "changeme";

type CameraMode = "dynamic" | "locked_back" | "locked_front";
type SessionStatus =
  | "idle"
  | "preparing"
  | "ready_for_user"
  | "connecting"
  | "connected"
  | "live"
  | "injecting"
  | "active"
  | "error"
  | "failed"
  | "connection_lost"
  | "ended"
  | string;

interface LinkRow {
  id: string;
  label: string;
  pad_code: string;
  camera_mode: CameraMode;
  back_definition_id: number;
  back_framerate_id: number;
  back_bitrate_id: number;
  front_definition_id: number;
  front_framerate_id: number;
  front_bitrate_id: number;
  session_status: SessionStatus;
}

const DEF_OPTS = [
  { v: 12, label: "540 × 960" },
  { v: 15, label: "720 × 1280" },
  { v: 17, label: "1080 × 1920 (Full HD)" },
];
const FR_OPTS = [
  { v: 5, label: "1 fps" },
  { v: 6, label: "5 fps" },
  { v: 7, label: "10 fps" },
  { v: 8, label: "15 fps" },
  { v: 3, label: "30 fps" },
];
const BR_OPTS = [
  { v: 8, label: "5 Mbps" },
  { v: 11, label: "10 Mbps" },
  { v: 12, label: "12 Mbps" },
];

const NEW_DEFAULTS = (id: string): LinkRow => ({
  id,
  label: id,
  pad_code: "",
  camera_mode: "dynamic",
  back_definition_id: 17,
  back_framerate_id: 6,
  back_bitrate_id: 11,
  front_definition_id: 15,
  front_framerate_id: 8,
  front_bitrate_id: 8,
  session_status: "idle",
});

function randomSlug() {
  return Math.random().toString(36).slice(2, 8);
}

function Admin() {
  const [authed, setAuthed] = useState(false);
  const [pw, setPw] = useState("");
  const [pwError, setPwError] = useState("");

  if (!authed) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="mx-auto max-w-sm px-4 py-16">
          <h1 className="text-2xl font-bold tracking-tight">Admin</h1>
          <p className="mt-2 text-sm text-muted-foreground">Enter the admin password.</p>
          <form
            className="mt-6 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (pw === ADMIN_PASSWORD) {
                setAuthed(true);
                setPwError("");
              } else {
                setPwError("Incorrect password");
              }
            }}
          >
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="Password"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              autoFocus
            />
            {pwError && <p className="text-sm text-destructive">{pwError}</p>}
            <button
              type="submit"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Unlock
            </button>
          </form>
        </div>
      </div>
    );
  }

  return <AdminPanel />;
}

function AdminPanel() {
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const reload = async () => {
    const { data, error } = await supabase
      .from("links" as any)
      .select(
        "id, label, pad_code, camera_mode, back_definition_id, back_framerate_id, back_bitrate_id, front_definition_id, front_framerate_id, front_bitrate_id",
      )
      .order("created_at", { ascending: true });
    if (error) {
      setStatus("Load failed: " + error.message);
    } else {
      setLinks((data ?? []) as unknown as LinkRow[]);
    }
    setLoaded(true);
  };

  useEffect(() => {
    void reload();
  }, []);

  const editing = links.find((l) => l.id === editingId) ?? null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-3xl font-bold tracking-tight">Admin — Links</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Each link maps to one phone. Share the link URL with the end user.
        </p>

        {!loaded ? (
          <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
        ) : editing ? (
          <LinkEditor
            row={editing}
            onClose={() => setEditingId(null)}
            onSaved={async () => {
              await reload();
              setStatus("Saved.");
            }}
          />
        ) : (
          <LinkList
            links={links}
            onEdit={(id) => setEditingId(id)}
            onCreated={async () => {
              await reload();
            }}
          />
        )}

        {status && <p className="mt-4 text-sm text-muted-foreground">{status}</p>}
      </div>
    </div>
  );
}

function LinkList({
  links,
  onEdit,
  onCreated,
}: {
  links: LinkRow[];
  onEdit: (id: string) => void;
  onCreated: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newPad, setNewPad] = useState("");
  const [error, setError] = useState("");

  const create = async () => {
    setError("");
    const id = (newId || randomSlug()).trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      setError("ID must contain only letters, numbers, dashes, underscores.");
      return;
    }
    if (!newPad.trim()) {
      setError("Pad code is required.");
      return;
    }
    const row = {
      ...NEW_DEFAULTS(id),
      label: newLabel.trim() || id,
      pad_code: newPad.trim(),
    };
    const { error } = await supabase.from("links" as any).insert(row as any);
    if (error) {
      setError(error.message);
      return;
    }
    setNewId("");
    setNewLabel("");
    setNewPad("");
    setCreating(false);
    await onCreated();
  };

  return (
    <div className="mt-8 space-y-4">
      <div className="space-y-2">
        {links.length === 0 && (
          <p className="text-sm text-muted-foreground">No links yet.</p>
        )}
        {links.map((l) => (
          <LinkRowItem key={l.id} row={l} onEdit={() => onEdit(l.id)} />
        ))}
      </div>

      {creating ? (
        <div className="rounded-lg border border-border bg-card p-5 text-card-foreground">
          <h3 className="text-base font-semibold">New link</h3>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Label text="Slug (optional)">
              <input
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="auto"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </Label>
            <Label text="Label">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Phone B"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </Label>
            <Label text="Pad code">
              <input
                value={newPad}
                onChange={(e) => setNewPad(e.target.value)}
                placeholder="APP..."
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </Label>
          </div>
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
          <div className="mt-4 flex gap-3">
            <button
              onClick={create}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Create
            </button>
            <button
              onClick={() => setCreating(false)}
              className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          New link
        </button>
      )}
    </div>
  );
}

function LinkRowItem({ row, onEdit }: { row: LinkRow; onEdit: () => void }) {
  const url =
    typeof window !== "undefined"
      ? `${window.location.origin}/link/${row.id}`
      : `/link/${row.id}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {}
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-sm font-semibold">{row.label}</div>
        <div className="text-xs text-muted-foreground">
          <code className="font-mono">{url}</code>
        </div>
        <div className="text-xs text-muted-foreground">
          pad: <code className="font-mono">{row.pad_code}</code> · mode: {row.camera_mode}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={copy}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >
          {copied ? "Copied!" : "Copy URL"}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >
          Open
        </a>
        <a
          href={`/view/${row.id}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >
          View Live
        </a>
        <button
          onClick={onEdit}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          Edit
        </button>
      </div>
    </div>
  );
}

function LinkEditor({
  row,
  onClose,
  onSaved,
}: {
  row: LinkRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<LinkRow>(row);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    const { id, ...update } = draft;
    const { error } = await supabase
      .from("links" as any)
      .update(update as any)
      .eq("id", id);
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    await onSaved();
    onClose();
  };

  return (
    <div className="mt-8 space-y-6">
      <button
        onClick={onClose}
        className="text-sm text-muted-foreground hover:underline"
      >
        ← Back to links
      </button>

      <Section title="Identity">
        <Label text="ID (slug)">
          <input
            value={draft.id}
            disabled
            className="w-full rounded-md border border-input bg-muted px-3 py-2 text-sm"
          />
        </Label>
        <Label text="Label">
          <input
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Label>
        <Label text="Pad code">
          <input
            value={draft.pad_code}
            onChange={(e) => setDraft({ ...draft, pad_code: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </Label>
      </Section>

      <Section title="Camera mode">
        <Label text="Mode">
          <select
            value={draft.camera_mode}
            onChange={(e) =>
              setDraft({ ...draft, camera_mode: e.target.value as CameraMode })
            }
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="dynamic">Dynamic (follow cloud phone)</option>
            <option value="locked_back">Locked to back</option>
            <option value="locked_front">Locked to front</option>
          </select>
        </Label>
      </Section>

      <Section title="Back camera quality (sharp / static detail)">
        <QualityGrid
          def={draft.back_definition_id}
          fr={draft.back_framerate_id}
          br={draft.back_bitrate_id}
          onDef={(v) => setDraft({ ...draft, back_definition_id: v })}
          onFr={(v) => setDraft({ ...draft, back_framerate_id: v })}
          onBr={(v) => setDraft({ ...draft, back_bitrate_id: v })}
        />
      </Section>

      <Section title="Front camera quality (smooth / movement)">
        <QualityGrid
          def={draft.front_definition_id}
          fr={draft.front_framerate_id}
          br={draft.front_bitrate_id}
          onDef={(v) => setDraft({ ...draft, front_definition_id: v })}
          onFr={(v) => setDraft({ ...draft, front_framerate_id: v })}
          onBr={(v) => setDraft({ ...draft, front_bitrate_id: v })}
        />
      </Section>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onClose}
          className="rounded-md border border-input bg-background px-5 py-2 text-sm font-medium hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-5 text-card-foreground">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{text}</span>
      {children}
    </label>
  );
}

function QualityGrid(props: {
  def: number; fr: number; br: number;
  onDef: (v: number) => void; onFr: (v: number) => void; onBr: (v: number) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Label text="Resolution">
        <Select value={props.def} onChange={props.onDef} options={DEF_OPTS} />
      </Label>
      <Label text="Framerate">
        <Select value={props.fr} onChange={props.onFr} options={FR_OPTS} />
      </Label>
      <Label text="Bitrate">
        <Select value={props.br} onChange={props.onBr} options={BR_OPTS} />
      </Label>
    </div>
  );
}

function Select({
  value, onChange, options,
}: {
  value: number;
  onChange: (v: number) => void;
  options: { v: number; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
    >
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label} (id {o.v})
        </option>
      ))}
    </select>
  );
}
