"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { analyzeAudio } from "@/lib/analysis";
import { GENRES } from "@/lib/prompt";
import type { Track } from "@/lib/types";

const ALLOWED_AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/x-m4a",
  aac: "audio/aac",
  mp4: "audio/mp4",
  aif: "audio/x-aiff",
  aiff: "audio/x-aiff",
  webm: "audio/webm",
};

type Phase = "idle" | "analyzing" | "uploading" | "done" | "error";

export default function Dashboard({
  email,
  initialTracks,
}: {
  email: string;
  initialTracks: Track[];
}) {
  const router = useRouter();
  const [tracks, setTracks] = useState<Track[]>(initialTracks);
  const [genre, setGenre] = useState("Auto");
  const [phase, setPhase] = useState<Phase>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastTrack, setLastTrack] = useState<Track | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = phase === "analyzing" || phase === "uploading";

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  async function handleFile(file: File) {
    if (busy) return;
    setError(null);
    setLastTrack(null);

    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    const mime = ALLOWED_AUDIO_MIME[ext];
    if (!mime) {
      setPhase("error");
      setError("Formato no admitido. Usa MP3, WAV, FLAC, OGG, M4A, AAC…");
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      setPhase("error");
      setError("La pista supera los 100 MB.");
      return;
    }

    try {
      setPhase("analyzing");
      setStatusMsg("Analizando BPM, tono y energía… (todo en tu navegador)");
      const analysis = await analyzeAudio(file);

      setPhase("uploading");
      setStatusMsg("Subiendo a tu biblioteca…");

      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Sesión caducada. Vuelve a entrar.");

      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("tracks")
        .upload(path, file, { contentType: mime, upsert: false });
      if (upErr) throw new Error(`No se pudo subir la pista: ${upErr.message}`);

      const { data: row, error: insErr } = await supabase
        .from("tracks")
        .insert({
          filename: file.name,
          storage_path: path,
          mime_type: mime,
          duration_sec: analysis.durationSec,
          bpm: analysis.bpm,
          musical_key: analysis.musicalKey,
          scale: analysis.scale,
          camelot: analysis.camelot,
          energy: analysis.energy,
          genre: genre === "Auto" ? null : genre,
          analysis: analysis as unknown as Record<string, unknown>,
        })
        .select()
        .single();
      if (insErr) throw new Error(`No se pudo guardar: ${insErr.message}`);

      setTracks((prev) => [row as Track, ...prev]);
      setLastTrack(row as Track);
      setPhase("done");
      router.refresh();
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "Error inesperado");
    }
  }

  const summary = useMemo(() => {
    if (!lastTrack) return null;
    return lastTrack;
  }, [lastTrack]);

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-[#0b0d14]/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-3">
          <Link href="/" className="text-lg font-bold text-white">
            Sine<span className="text-indigo-400">AI</span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-slate-500 sm:inline">{email}</span>
            <button
              onClick={signOut}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white"
            >
              Salir
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-8 px-4 py-8">
        {/* Zona de subida */}
        <section>
          <h1 className="text-2xl font-bold text-white">
            Tu biblioteca de pistas
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Sube un instrumental, analízalo y genera pistas secundarias que lo
            complementen.
          </p>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void handleFile(f);
            }}
            className={`mt-4 rounded-2xl border-2 border-dashed p-6 transition ${
              dragOver
                ? "border-indigo-400 bg-indigo-500/10"
                : "border-slate-700 bg-[#111522]/70 hover:border-slate-500"
            }`}
          >
            <div className="flex flex-col items-center gap-3 text-center sm:flex-row sm:text-left">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-indigo-600/20 text-2xl">
                🎵
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-200">
                  Arrastra aquí tu pista instrumental
                </p>
                <p className="text-xs text-slate-500">
                  MP3, WAV, FLAC, OGG, M4A… hasta 100 MB
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                  disabled={busy}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500"
                >
                  {GENRES.map((g) => (
                    <option key={g} value={g}>
                      {g === "Auto" ? "Género: auto" : g}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => inputRef.current?.click()}
                  disabled={busy}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
                >
                  Elegir fichero
                </button>
              </div>
            </div>

            <input
              ref={inputRef}
              type="file"
              accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = "";
              }}
            />

            {/* Progreso */}
            {(busy || phase === "error" || phase === "done") && (
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                {busy && (
                  <div className="flex items-center gap-3">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
                    <span className="text-sm text-slate-300">{statusMsg}</span>
                  </div>
                )}
                {phase === "error" && error && (
                  <p className="text-sm text-rose-400">⚠ {error}</p>
                )}
                {phase === "done" && summary && (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-emerald-400">
                        ✓ {summary.filename}
                      </span>
                      <Badge>{Math.round(summary.bpm ?? 0)} BPM</Badge>
                      <Badge>
                        {summary.musical_key} {summary.scale} · {summary.camelot}
                      </Badge>
                      <Badge>Energía {summary.energy ?? 0}%</Badge>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setPhase("idle");
                          setLastTrack(null);
                        }}
                        className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
                      >
                        Otra pista
                      </button>
                      <Link
                        href={`/track/${summary.id}`}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                      >
                        Complementar →
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Lista de pistas */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
            Pistas ({tracks.length})
          </h2>
          {tracks.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-[#111522]/60 p-10 text-center">
              <p className="text-4xl">🎧</p>
              <p className="mt-3 text-sm text-slate-400">
                Aún no hay pistas. Sube tu primer instrumental para empezar.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {tracks.map((t) => (
                <Link
                  key={t.id}
                  href={`/track/${t.id}`}
                  className="group rounded-xl border border-slate-800 bg-[#111522]/70 p-4 transition hover:border-indigo-500/60 hover:bg-[#141a2b]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-200 group-hover:text-white">
                      {t.filename}
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-500">
                      {new Date(t.created_at).toLocaleDateString("es-ES")}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge>{Math.round(t.bpm ?? 0)} BPM</Badge>
                    <Badge>
                      {t.musical_key} {t.scale}
                    </Badge>
                    <Badge>{t.camelot}</Badge>
                    {t.genre && <Badge>{t.genre}</Badge>}
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    {formatDuration(t.duration_sec)} ·{" "}
                    <span className="text-indigo-400 opacity-0 transition group-hover:opacity-100">
                      Complementar →
                    </span>
                  </p>
                </Link>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-slate-800/80 px-2 py-0.5 font-mono text-[11px] text-slate-300">
      {children}
    </span>
  );
}

function formatDuration(sec: number | null): string {
  if (!sec || !Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
