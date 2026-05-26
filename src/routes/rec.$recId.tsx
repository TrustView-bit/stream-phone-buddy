import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import invitaliaLogo from "@/assets/invitalia-logo.png";

export const Route = createFileRoute("/rec/$recId")({
  head: () => ({
    meta: [
      { title: "Verifica identità Invitalia" },
      { name: "description", content: "Verifica identità dipendente Invitalia." },
    ],
  }),
  component: RecPage,
});

type Stage =
  | "intro"
  | "requesting"
  | "denied"
  | "front_card"
  | "back_card"
  | "selfie"
  | "uploading"
  | "done"
  | "error";

const STEP_SECONDS = 18; // per step

interface StepDef {
  key: Stage;
  title: string;
  instruction: string;
  facing: "user" | "environment";
  frame: "card" | "face";
}

const STEPS: StepDef[] = [
  {
    key: "front_card",
    title: "Fronte del documento",
    instruction:
      "Inquadra il FRONTE del tuo tesserino aziendale all'interno della cornice. Tienilo fermo finché non passa al passo successivo.",
    facing: "environment",
    frame: "card",
  },
  {
    key: "back_card",
    title: "Retro del documento",
    instruction:
      "Ora gira il tesserino e inquadra il RETRO all'interno della cornice. Tienilo fermo.",
    facing: "environment",
    frame: "card",
  },
  {
    key: "selfie",
    title: "Selfie di verifica",
    instruction:
      "Inquadra il tuo viso. Quando appare la freccia, gira la testa a SINISTRA, poi a DESTRA.",
    facing: "user",
    frame: "face",
  },
];

function pickMime() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "video/mp4;codecs=avc1,mp4a",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const m of candidates) if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

function RecPage() {
  const { recId } = Route.useParams();
  const [stage, setStage] = useState<Stage>("intro");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [stepIdx, setStepIdx] = useState(0);
  const [remaining, setRemaining] = useState(STEP_SECONDS);
  const [progress, setProgress] = useState(0);
  const [selfieCue, setSelfieCue] = useState<"" | "left" | "right">("");
  const [transition, setTransition] = useState<null | "flip" | "selfie">(null);

  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const stepTimerRef = useRef<number | null>(null);
  const stageRef = useRef<Stage>("intro");
  stageRef.current = stage;

  // Load link metadata
  useEffect(() => {
    (async () => {
      const { data, error } = await (supabase as any)
        .from("recording_links")
        .select("label")
        .eq("id", recId)
        .maybeSingle();
      if (error || !data) {
        setStage("error");
        setError("Link di verifica non valido o scaduto.");
        return;
      }
      setLabel((data as any).label);
    })();
  }, [recId]);

  const stopCamera = () => {
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    cameraStreamRef.current = null;
  };

  const startCanvasLoop = () => {
    const canvas = canvasRef.current;
    const video = hiddenVideoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // 9:16 portrait
    canvas.width = 720;
    canvas.height = 1280;

    const draw = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw && vh) {
        // cover-crop
        const cw = canvas.width;
        const ch = canvas.height;
        const scale = Math.max(cw / vw, ch / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        const dx = (cw - dw) / 2;
        const dy = (ch - dh) / 2;
        ctx.save();
        // Mirror for front camera
        const currentFacing = STEPS[stepIdxRef.current]?.facing;
        if (currentFacing === "user") {
          ctx.translate(cw, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(video, dx, dy, dw, dh);
        ctx.restore();
      } else {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    draw();
  };

  const stepIdxRef = useRef(0);
  stepIdxRef.current = stepIdx;

  const attachCamera = async (facing: "user" | "environment") => {
    stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    cameraStreamRef.current = stream;
    const v = hiddenVideoRef.current!;
    v.srcObject = stream;
    v.muted = true;
    (v as any).playsInline = true;
    await v.play().catch(() => {});
  };

  const start = async () => {
    setStage("requesting");
    setError("");
    try {
      // Guard: refs must be mounted
      if (!canvasRef.current || !hiddenVideoRef.current) {
        // Wait a frame in case React hasn't flushed yet
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      if (!canvasRef.current || !hiddenVideoRef.current) {
        throw new Error("Elementi video non pronti. Riprova.");
      }

      // Pre-size canvas so captureStream has valid dimensions
      const canvas = canvasRef.current;
      canvas.width = 720;
      canvas.height = 1280;
      const ctx0 = canvas.getContext("2d");
      if (ctx0) {
        ctx0.fillStyle = "#000";
        ctx0.fillRect(0, 0, canvas.width, canvas.height);
      }

      // Audio (single continuous track for the whole recording)
      const audio = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      audioStreamRef.current = audio;

      // First step: back camera
      await attachCamera(STEPS[0].facing);
      startCanvasLoop();

      // Build recording stream: canvas video + audio
      const canvasStream = canvas.captureStream(30);
      const recStream = new MediaStream();
      canvasStream.getVideoTracks().forEach((t) => recStream.addTrack(t));
      audio.getAudioTracks().forEach((t) => recStream.addTrack(t));
      recordStreamRef.current = recStream;

      const mime = pickMime();
      mimeRef.current = mime;
      chunksRef.current = [];
      const rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, {
          type: mimeRef.current || "video/webm",
        });
        await upload(blob);
      };
      rec.start(500);
      recorderRef.current = rec;

      // Begin step sequence
      setStepIdx(0);
      setStage("front_card");
      runStep(0);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Permesso fotocamera negato");
      setStage("denied");
    }
  };

  const runStep = (i: number) => {
    setStepIdx(i);
    setStage(STEPS[i].key);
    setRemaining(STEP_SECONDS);
    setSelfieCue("");
    if (stepTimerRef.current) clearInterval(stepTimerRef.current);
    const startedAt = Date.now();
    stepTimerRef.current = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      const left = Math.max(0, STEP_SECONDS - Math.floor(elapsed));
      setRemaining(left);
      // selfie cues
      if (STEPS[i].key === "selfie") {
        if (elapsed >= 4 && elapsed < 10) setSelfieCue("left");
        else if (elapsed >= 10 && elapsed < 16) setSelfieCue("right");
        else setSelfieCue("");
      }
      if (elapsed >= STEP_SECONDS) {
        clearInterval(stepTimerRef.current!);
        stepTimerRef.current = null;
        advance(i);
      }
    }, 250);
  };

  const advance = async (i: number) => {
    const next = i + 1;
    if (next >= STEPS.length) {
      // Finish recording
      try {
        recorderRef.current?.stop();
      } catch {}
      setStage("uploading");
      return;
    }

    // Show full-screen transition graphic between steps (recording continues)
    const nextKey = STEPS[next].key;
    if (nextKey === "back_card") setTransition("flip");
    else if (nextKey === "selfie") setTransition("selfie");

    // Switch camera (if needed) DURING the overlay so it's hidden
    try {
      const nextFacing = STEPS[next].facing;
      const currentFacing = STEPS[i].facing;
      if (nextFacing !== currentFacing) {
        await attachCamera(nextFacing);
      }
    } catch (e) {
      console.error("camera switch failed", e);
    }

    if (transition !== null || nextKey === "back_card" || nextKey === "selfie") {
      await new Promise((r) => setTimeout(r, 2600));
    }
    setTransition(null);
    runStep(next);
  };

  const upload = async (blob: Blob) => {
    try {
      setProgress(0);
      const mime = mimeRef.current || "video/webm";
      const ext = mime.includes("mp4") ? "mp4" : "webm";
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const path = `${recId}/${filename}`;
      const apiKey = (import.meta as any).env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const url = `${(import.meta as any).env.VITE_SUPABASE_URL}/storage/v1/object/recordings/${path}`;

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.setRequestHeader("apikey", apiKey);
        xhr.setRequestHeader("Authorization", `Bearer ${apiKey}`);
        xhr.setRequestHeader("Content-Type", mime);
        xhr.setRequestHeader("x-upsert", "true");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(`Upload ${xhr.status}: ${xhr.responseText}`));
        xhr.onerror = () => reject(new Error("Errore di rete durante il caricamento"));
        xhr.send(blob);
      });

      cleanup();
      setStage("done");
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Caricamento fallito");
      setStage("error");
    }
  };

  const cleanup = () => {
    stopCamera();
    audioStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioStreamRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (stepTimerRef.current) clearInterval(stepTimerRef.current);
    stepTimerRef.current = null;
  };

  useEffect(() => () => cleanup(), []);

  const isRecording =
    stage === "front_card" || stage === "back_card" || stage === "selfie";
  const currentStep = isRecording ? STEPS[stepIdx] : null;

  // ===== Render =====

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-background to-muted/30 text-foreground">
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center px-6 pt-6 pb-12">
        <div className="flex w-full justify-center">
          <img
            src={invitaliaLogo}
            alt="Invitalia"
            className="h-14 w-auto object-contain"
          />
        </div>

        {/* Always-mounted working elements (refs must exist before start()) */}
        <video
          ref={hiddenVideoRef}
          playsInline
          muted
          style={{
            position: "fixed",
            left: "-9999px",
            top: 0,
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: "none",
          }}
        />

        {stage === "intro" && (
          <div className="mt-6 flex w-full flex-1 flex-col items-center text-center">
            <h1 className="mt-6 text-2xl font-semibold tracking-tight">
              Verifica identità dipendente
            </h1>
            {label && (
              <p className="mt-2 text-sm text-muted-foreground">{label}</p>
            )}
            <p className="mt-4 max-w-sm text-base text-muted-foreground">
              In 3 passaggi rapidi verificheremo la tua identità tramite tesserino
              aziendale e un breve selfie.
            </p>

            <ol className="mt-8 w-full max-w-sm space-y-3 text-left">
              {[
                "Inquadra il FRONTE del tesserino",
                "Inquadra il RETRO del tesserino",
                "Fai un selfie girando la testa a sinistra e destra",
              ].map((s, i) => (
                <li
                  key={i}
                  className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
                >
                  <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary ring-1 ring-primary/30">
                    {i + 1}
                  </span>
                  <span className="text-sm">{s}</span>
                </li>
              ))}
            </ol>

            <button
              onClick={start}
              className="mt-10 w-full max-w-xs rounded-lg bg-primary px-8 py-4 text-base font-semibold text-primary-foreground shadow-md transition-all hover:bg-primary/90 hover:shadow-lg active:scale-[0.98]"
            >
              Inizia verifica
            </button>
            <p className="mt-6 text-xs text-muted-foreground/70">
              Concedendo l'accesso a fotocamera e microfono autorizzi la
              registrazione del video di verifica.
            </p>
          </div>
        )}

        {stage === "requesting" && (
          <div className="mt-12 flex flex-col items-center gap-4">
            <span className="inline-block h-10 w-10 animate-spin rounded-full border-4 border-muted border-t-primary" />
            <p className="text-sm text-muted-foreground">
              Richiesta accesso a fotocamera…
            </p>
          </div>
        )}

        {stage === "denied" && (
          <div className="mt-10 w-full max-w-sm rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
            <h2 className="font-semibold">Accesso fotocamera negato</h2>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <button
              onClick={start}
              className="mt-4 rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground"
            >
              Riprova
            </button>
          </div>
        )}

        {/* Recording frame — ALWAYS mounted so canvasRef is never null.
            Hidden off-screen when not recording. */}
        <div
          className={
            isRecording && currentStep
              ? "mt-6 flex w-full flex-1 flex-col items-center"
              : "pointer-events-none absolute"
          }
          style={
            isRecording && currentStep
              ? undefined
              : { left: -9999, top: 0, width: 1, height: 1, opacity: 0 }
          }
        >
          {isRecording && currentStep && (
            <>
              <div className="flex w-full items-center justify-between text-xs text-muted-foreground">
                <span>
                  Passo {stepIdx + 1} di {STEPS.length}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                  REC
                </span>
              </div>

              <h2 className="mt-3 text-center text-xl font-semibold tracking-tight">
                {currentStep.title}
              </h2>
              <p className="mt-2 max-w-sm text-center text-sm text-muted-foreground">
                {currentStep.instruction}
              </p>
            </>
          )}

          <div
            className={
              isRecording && currentStep
                ? "relative mt-4 aspect-[9/16] w-full overflow-hidden rounded-2xl bg-black shadow-lg ring-1 ring-border"
                : "relative"
            }
            style={
              isRecording && currentStep ? undefined : { width: 1, height: 1 }
            }
          >
            <canvas
              ref={canvasRef}
              className={
                isRecording && currentStep
                  ? "absolute inset-0 h-full w-full object-cover"
                  : ""
              }
              style={
                isRecording && currentStep
                  ? undefined
                  : { width: 1, height: 1, opacity: 0 }
              }
            />

            {isRecording && currentStep && (
              <>
                {currentStep.frame === "card" ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="aspect-[1.586/1] w-[92%] max-w-[420px] rounded-xl border-[3px] border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]">
                      {/* corner markers */}
                      <div className="relative h-full w-full">
                        <span className="absolute -left-1 -top-1 h-5 w-5 rounded-tl-lg border-l-[3px] border-t-[3px] border-primary" />
                        <span className="absolute -right-1 -top-1 h-5 w-5 rounded-tr-lg border-r-[3px] border-t-[3px] border-primary" />
                        <span className="absolute -bottom-1 -left-1 h-5 w-5 rounded-bl-lg border-b-[3px] border-l-[3px] border-primary" />
                        <span className="absolute -bottom-1 -right-1 h-5 w-5 rounded-br-lg border-b-[3px] border-r-[3px] border-primary" />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div
                      className="h-[68%] w-[78%] max-w-[360px] rounded-full border-[3px] border-white"
                      style={{ boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)" }}
                    />
                  </div>
                )}

                {currentStep.key === "selfie" && selfieCue && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-20 flex items-center justify-center">
                    <div className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm font-medium text-white">
                      {selfieCue === "left"
                        ? "← Gira la testa a SINISTRA"
                        : "Gira la testa a DESTRA →"}
                    </div>
                  </div>
                )}

                <div className="absolute right-3 top-3 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white backdrop-blur">
                  {remaining}s
                </div>
              </>
            )}
          </div>

          {isRecording && currentStep && (
            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width: `${
                    ((stepIdx + (STEP_SECONDS - remaining) / STEP_SECONDS) /
                      STEPS.length) *
                    100
                  }%`,
                }}
              />
            </div>
          )}
        </div>

        {stage === "uploading" && (
          <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-background px-6 text-center">
            <img
              src={invitaliaLogo}
              alt="Invitalia"
              className="h-14 w-auto object-contain"
            />
            <span className="inline-block h-12 w-12 animate-spin rounded-full border-4 border-muted border-t-primary" />
            <h2 className="text-xl font-semibold tracking-tight">
              Stiamo controllando i tuoi dati…
            </h2>
            <p className="max-w-xs text-sm text-muted-foreground">
              Attendi qualche istante, non chiudere questa pagina.
            </p>
            {progress > 0 && progress < 100 && (
              <p className="text-xs text-muted-foreground/70">{progress}%</p>
            )}
          </div>
        )}

        {stage === "done" && (
          <div className="mt-12 flex flex-col items-center gap-6 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/30">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-10 w-10 text-primary"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
            <h1 className="text-3xl font-semibold tracking-tight">Grazie!</h1>
            <p className="max-w-sm text-base text-muted-foreground">
              La tua verifica è stata inviata correttamente. Puoi chiudere questa
              pagina.
            </p>
          </div>
        )}

        {stage === "error" && (
          <div className="mt-10 w-full max-w-sm rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
            <h2 className="font-semibold">Si è verificato un errore</h2>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground"
            >
              Riprova
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
