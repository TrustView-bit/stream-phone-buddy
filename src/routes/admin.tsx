import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Admin — Cloud Phone Viewer" },
      { name: "description", content: "Settings for Cloud Phone Viewer." },
    ],
  }),
  component: Admin,
});

const ADMIN_PASSWORD = "changeme";

type CameraMode = "dynamic" | "locked_back" | "locked_front";

interface SettingsRow {
  pad_code: string;
  camera_mode: CameraMode;
  back_definition_id: number;
  back_framerate_id: number;
  back_bitrate_id: number;
  front_definition_id: number;
  front_framerate_id: number;
  front_bitrate_id: number;
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

const DEFAULTS: SettingsRow = {
  pad_code: "APP63U6GYP7UDGQV",
  camera_mode: "dynamic",
  back_definition_id: 17,
  back_framerate_id: 6,
  back_bitrate_id: 11,
  front_definition_id: 15,
  front_framerate_id: 8,
  front_bitrate_id: 8,
};

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
  const [row, setRow] = useState<SettingsRow>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select(
          "pad_code, camera_mode, back_definition_id, back_framerate_id, back_bitrate_id, front_definition_id, front_framerate_id, front_bitrate_id",
        )
        .eq("id", "default")
        .maybeSingle();
      if (error) {
        setStatus("Failed to load settings: " + error.message);
      } else if (data) {
        setRow({
          pad_code: data.pad_code ?? DEFAULTS.pad_code,
          camera_mode: (data.camera_mode as CameraMode) ?? "dynamic",
          back_definition_id: data.back_definition_id ?? 17,
          back_framerate_id: data.back_framerate_id ?? 6,
          back_bitrate_id: data.back_bitrate_id ?? 11,
          front_definition_id: data.front_definition_id ?? 15,
          front_framerate_id: data.front_framerate_id ?? 8,
          front_bitrate_id: data.front_bitrate_id ?? 8,
        });
      }
      setLoaded(true);
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus("Saving…");
    const { error } = await supabase
      .from("app_settings")
      .update(row)
      .eq("id", "default");
    setSaving(false);
    setStatus(error ? "Save failed: " + error.message : "Saved.");
  };

  const injectorUrl = typeof window !== "undefined" ? window.location.origin + "/" : "/";

  const copyInjector = async () => {
    try {
      await navigator.clipboard.writeText(injectorUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {
      setCopied(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-3xl font-bold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cloud Phone Viewer settings. Changes apply to the injector on next load.
        </p>

        {!loaded ? (
          <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="mt-8 space-y-8">
            {/* Pad code */}
            <Section title="Target phone">
              <Label text="Pad code">
                <input
                  type="text"
                  value={row.pad_code}
                  onChange={(e) => setRow({ ...row, pad_code: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </Label>
            </Section>

            {/* Camera mode */}
            <Section title="Camera mode">
              <Label text="Mode">
                <select
                  value={row.camera_mode}
                  onChange={(e) =>
                    setRow({ ...row, camera_mode: e.target.value as CameraMode })
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="dynamic">Dynamic (follow cloud phone)</option>
                  <option value="locked_back">Locked to back</option>
                  <option value="locked_front">Locked to front</option>
                </select>
              </Label>
            </Section>

            {/* Back quality */}
            <Section title="Back camera quality (sharp / static detail)">
              <QualityGrid
                def={row.back_definition_id}
                fr={row.back_framerate_id}
                br={row.back_bitrate_id}
                onDef={(v) => setRow({ ...row, back_definition_id: v })}
                onFr={(v) => setRow({ ...row, back_framerate_id: v })}
                onBr={(v) => setRow({ ...row, back_bitrate_id: v })}
              />
            </Section>

            {/* Front quality */}
            <Section title="Front camera quality (smooth / movement)">
              <QualityGrid
                def={row.front_definition_id}
                fr={row.front_framerate_id}
                br={row.front_bitrate_id}
                onDef={(v) => setRow({ ...row, front_definition_id: v })}
                onFr={(v) => setRow({ ...row, front_framerate_id: v })}
                onBr={(v) => setRow({ ...row, front_bitrate_id: v })}
              />
            </Section>

            {/* Actions */}
            <div className="flex flex-wrap gap-3">
              <button
                onClick={save}
                disabled={saving}
                className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <a
                href="/"
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-input bg-background px-5 py-2 text-sm font-medium hover:bg-accent"
              >
                Test connection
              </a>
              <button
                onClick={copyInjector}
                className="rounded-md border border-input bg-background px-5 py-2 text-sm font-medium hover:bg-accent"
              >
                {copied ? "Copied!" : "Generate injector link"}
              </button>
            </div>

            <div className="text-xs text-muted-foreground">
              Injector URL: <code className="font-mono">{injectorUrl}</code>
            </div>

            {status && (
              <p className="text-sm text-muted-foreground">{status}</p>
            )}
          </div>
        )}
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
