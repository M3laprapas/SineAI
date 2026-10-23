"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { GENRES, buildComplementPrompt } from "@/lib/prompt";
import { analyzeRhythmFromUrl, type MeasuredRhythm } from "@/lib/analysis";
import {
  alignStarts,
  beatAtOrAfter,
  describeTempoPlan,
  diagnoseTempo,
  planTempo,
  type RhythmGrid,
} from "@/lib/align";
import type { Generation, Idea, Track } from "@/lib/types";

const STATUS_LABEL: Record<Generation["status"], string> = {
  queued: "⏳ En cola",
  running: "🔄 Generando…",
  done: "✅ Lista",
  error: "❌ Error",
};

export default function TrackWorkspace({
  track,
  initialGenerations,
}: {
  track: Track;
  initialGenerations: Generation[];
}) {
  const [trackState, setTrackState] = useState(track);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [ideaUsed, setIdeaUsed] = useState(false);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [ideasBusy, setIdeasBusy] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [gens, setGens] = useState<Generation[]>(initialGenerations);
  const [resultUrls, setResultUrls] = useState<Record<string, string>>({});

  // Derivados del listado (declarados temprano: los efectos los usan).
  const hasActive = gens.some(
    (g) => g.status === "queued" || g.status === "running"
  );
  const hasDone = gens.some((g) => g.status === "done" && !!g.result_path);

  // ---------- Mezcla: escuchar original + complemento a la vez ----------
  const originalAudioRef = useRef<HTMLAudioElement | null>(null);
  const genAudioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const mixingRef = useRef<string | null>(null);
  // Durante el arranque programático de la mezcla, los eventos 'play' no deben
  // interpretarse como reproducción individual del usuario.
  const suppressEventsRef = useRef(false);
  const [mixingId, setMixingId] = useState<string | null>(null);
  const [mixVolume, setMixVolume] = useState(0.85);

  // ---------- Alineación al compás ----------
  // La rejilla de la pista original viene del análisis (subidas nuevas) o se
  // calcula bajo demanda y se guarda en tracks.analysis (pistas antiguas).
  const rhythmTriedRef = useRef(false);
  const [rhythmPending, setRhythmPending] = useState(false);
  // Ritmo medido de cada complemento generado (una vez por generación).
  const compRhythmRef = useRef<Record<string, MeasuredRhythm>>({});
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [tempoWarn, setTempoWarn] = useState<Record<string, string>>({});
  const [tempoInfo, setTempoInfo] = useState<
    Record<string, { complementBpm: number; rate: number; relation: string | null; fits: boolean }>
  >({});
  const [mixAligned, setMixAligned] = useState(false);
  // Diagnóstico de tempo por generación (reconocido una vez, reutilizado).
  const diagnosesRef = useRef<
    Record<string, ReturnType<typeof diagnoseTempo>>
  >({});

  function pauseOtherGenerations(keepId: string | null) {
    for (const [id, el] of Object.entries(genAudioRefs.current)) {
      if (id !== keepId) el?.pause();
    }
  }

  /** Corta la mezcla; `keepPlaying` (si se indica) es el único elemento que
   *  continúa sonando (reproducción individual iniciada por el usuario). */
  function endMix(keepPlaying: HTMLAudioElement | null) {
    mixingRef.current = null;
    setMixingId(null);
    setMixAligned(false);
    if (originalAudioRef.current !== keepPlaying) originalAudioRef.current?.pause();
    for (const el of Object.values(genAudioRefs.current)) {
      if (!el) continue;
      el.loop = false;
      el.playbackRate = 1; // restaura la velocidad natural del complemento
      if (el !== keepPlaying) el.pause();
    }
  }

  type AnalysisJson = { beats?: number[]; sectionStartSec?: number };

  /** Rejilla de compases de la pista original (beats medidos + BPM). */
  function trackGrid(): RhythmGrid | null {
    const a = trackState.analysis as AnalysisJson | null;
    const beats = Array.isArray(a?.beats)
      ? a!.beats!.filter((n) => typeof n === "number" && Number.isFinite(n))
      : null;
    const bpm = trackState.bpm ?? 0;
    if (beats && beats.length > 1 && bpm > 0) return { bpm, beats };
    return null;
  }

  /** Sección de la canción para la que está hecho el complemento. */
  function sectionStart(): number {
    const a = trackState.analysis as AnalysisJson | null;
    return typeof a?.sectionStartSec === "number" ? a.sectionStartSec : 0;
  }

  const alignReady = trackGrid() !== null;

  /** Reproduce la pista original y el complemento simultáneamente, alineados
   *  al compás y situando la original en su sección representativa:
   *  1. Mide el ritmo del complemento (una vez) para conocer su rejilla.
   *  2. Arranca cada audio EXACTAMENTE en un compás, al mismo instante →
   *     ambos downbeats caen juntos y las rejillas quedan sincronizadas.
   *  3. Sin ritmo medido, cae al bucle nativo anterior (compatibilidad). */
  async function startMix(genId: string) {
    const orig = originalAudioRef.current;
    const gen = genAudioRefs.current[genId];
    const url = resultUrls[genId];
    if (!orig || !gen || !url) return;

    if (!compRhythmRef.current[genId]) {
      setSyncingId(genId);
      try {
        compRhythmRef.current[genId] = await analyzeRhythmFromUrl(url);
      } catch {
        // Sin medición posible: la mezcla funciona sin alineación exacta.
      }
      setSyncingId(null);
    }

    const grid = trackGrid();
    const comp = compRhythmRef.current[genId];
    const section = sectionStart();

    let origStart = section;
    let compStart = 0;
    let aligned = false;
    let warn = "";
    let plan: ReturnType<typeof planTempo> = null;

    if (grid && comp) {
      // El modelo casi nunca respeta el BPM pedido y el detector es ambiguo
      // en octava: reconocemos la relación musical y corregimos la velocidad
      // SOLO si el cambio es inaudible (nunca deformamos el tono).
      plan = planTempo(grid.bpm, comp.bpm);
      const diag = diagnosesRef.current[genId] ?? diagnoseTempo(grid.bpm, comp.bpm);
      diagnosesRef.current[genId] = diag;
      const starts = alignStarts(grid, comp, section);
      const maxOrig = Number.isFinite(orig.duration) ? orig.duration : Infinity;
      const maxComp = Number.isFinite(gen.duration) ? gen.duration : Infinity;
      origStart = Math.min(starts.originalStart, Math.max(0, maxOrig - 1));
      compStart = Math.min(starts.complementStart, Math.max(0, maxComp - 1));
      aligned = true;
      setTempoInfo((prev) => ({
        ...prev,
        [genId]: {
          complementBpm: comp.bpm,
          rate: plan ? plan.rate : 1,
          relation: diag.relation,
          fits: !!plan,
        },
      }));
      if (!plan) {
        warn = diag.relation
          ? `Tempo: el complemento va a ${comp.bpm.toFixed(1)} BPM (≈ ${diag.relation} de tu pista, ${Math.round(grid.bpm)} BPM). Entran alineados en el primer compás, pero sin corrección de tempo para no desafinar el tono: si quieres un encaje exacto, regenera.`
          : `Tempo: el complemento (${comp.bpm.toFixed(1)} BPM) no guarda una relación sencilla con tu pista (${Math.round(grid.bpm)} BPM); entra alineado al compás pero irá desfasado. Regenera para otro intento.`;
      } else if (Math.abs(plan.rate - 1) > 0.002) {
        warn = `Tempo ajustado: el complemento salió a ${comp.bpm.toFixed(1)} BPM (${describeTempoPlan(plan)}). En la mezcla lo reproduzco a ${plan.rate.toFixed(4)}× para clavarlo en tu tempo; el archivo original (reproductor y descarga) queda intacto.`;
      }
    }

    endMix(null);
    setTempoWarn((prev) => ({ ...prev, [genId]: warn }));
    setMixAligned(aligned);
    suppressEventsRef.current = true;
    orig.currentTime = origStart;
    orig.playbackRate = 1;
    gen.currentTime = compStart;
    gen.playbackRate = plan ? plan.rate : 1;
    // Con rejilla medida, el bucle lo manejamos nosotros para reiniciar el
    // complemento en el compás siguiente de la original (sin deriva de fase).
    gen.loop = !(grid && comp);
    gen.volume = mixVolume;
    mixingRef.current = genId;
    setMixingId(genId);
    try {
      await Promise.all([orig.play(), gen.play()]);
    } catch {
      mixingRef.current = null;
      setMixingId(null);
      setMixAligned(false);
    } finally {
      // Los eventos 'play' programáticos ya se dispararon: reactiva handlers.
      setTimeout(() => {
        suppressEventsRef.current = false;
      }, 0);
    }
  }

  /** El complemento (20 s) terminó durante la mezcla: reinícialo en el
   *  compás siguiente de la original para que cada vuelta vuelva a caer en
   *  tiempo y las rejillas no se deslicen. */
  function onComplementEnded(genId: string) {
    if (mixingRef.current !== genId) return;
    const grid = trackGrid();
    const orig = originalAudioRef.current;
    const gen = genAudioRefs.current[genId];
    if (!grid || !orig || !gen || orig.paused || orig.ended) {
      endMix(null);
      return;
    }
    const comp = compRhythmRef.current[genId];
    const compStart =
      comp && comp.beats.length && comp.beats[0] < 5 ? comp.beats[0] : 0;
    const gridBpm = trackGrid()?.bpm ?? 0;
    const rate = comp ? (planTempo(gridBpm, comp.bpm)?.rate ?? 1) : 1;
    // Pequeño margen (50 ms) para no coincidir con el instante actual.
    const next = beatAtOrAfter(grid, orig.currentTime + 0.05);
    const delay = Math.max(50, (next - orig.currentTime) * 1000);
    window.setTimeout(() => {
      if (mixingRef.current !== genId) return;
      const o = originalAudioRef.current;
      const g = genAudioRefs.current[genId];
      if (!o || !g || o.paused || o.ended) {
        endMix(null);
        return;
      }
      // 'play' programático: no debe interpretarse como reproducción individual.
      suppressEventsRef.current = true;
      g.currentTime = compStart;
      g.playbackRate = rate;
      g.volume = mixVolume;
      void g.play().catch(() => {});
      setTimeout(() => {
        suppressEventsRef.current = false;
      }, 0);
    }, delay);
  }

  function stopMix() {
    endMix(null);
  }

  function changeMixVolume(v: number) {
    setMixVolume(v);
    const el = mixingRef.current
      ? genAudioRefs.current[mixingRef.current]
      : null;
    if (el) el.volume = v;
  }

  // Al desmontar, corta cualquier reproducción.
  useEffect(() => {
    return () => {
      mixingRef.current = null;
      originalAudioRef.current?.pause();
      for (const el of Object.values(genAudioRefs.current)) el?.pause();
    };
  }, []);

  // URL firmada para reproducir la pista original
  useEffect(() => {
    let cancel = false;
    (async () => {
      const s = createClient();
      const { data } = await s.storage
        .from("tracks")
        .createSignedUrl(track.storage_path, 24 * 3600);
      if (data?.signedUrl && !cancel) setSourceUrl(data.signedUrl);
    })();
    return () => {
      cancel = true;
    };
  }, [track.storage_path]);

  // Pistas antiguas (analizadas antes de guardar beats/sección): mide sus
  // compases bajo demanda cuando ya hay algo que mezclar y guarda el
  // resultado en tracks.analysis para no repetirlo.
  useEffect(() => {
    if (!hasDone || !sourceUrl || rhythmTriedRef.current) return;
    rhythmTriedRef.current = true;
    if (trackGrid()) return;
    let cancel = false;
    setRhythmPending(true);
    (async () => {
      try {
        const r = await analyzeRhythmFromUrl(sourceUrl);
        if (cancel) return;
        const merged = { ...(trackState.analysis ?? {}), ...r };
        const s = createClient();
        await s.from("tracks").update({ analysis: merged }).eq("id", track.id);
        setTrackState((prev) => ({ ...prev, analysis: merged }));
      } catch {
        // Sin datos de ritmo: la mezcla sigue funcionando sin alineación.
      } finally {
        if (!cancel) setRhythmPending(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [hasDone, sourceUrl, track.id]);

  // Sondeo de estado mientras haya generaciones activas
  useEffect(() => {
    if (!hasActive) return;
    const iv = setInterval(async () => {
      const s = createClient();
      const { data } = await s
        .from("generations")
        .select("*")
        .eq("track_id", track.id)
        .order("created_at", { ascending: false });
      if (data) setGens(data as Generation[]);
    }, 3000);
    return () => clearInterval(iv);
  }, [hasActive, track.id]);

  // URLs firmadas de los resultados
  useEffect(() => {
    let cancel = false;
    (async () => {
      const s = createClient();
      const pending = gens.filter(
        (g) => g.status === "done" && g.result_path && !resultUrls[g.id]
      );
      for (const g of pending) {
        const { data } = await s.storage
          .from("generations")
          .createSignedUrl(g.result_path!, 6 * 3600);
        if (data?.signedUrl && !cancel) {
          setResultUrls((prev) => ({ ...prev, [g.id]: data.signedUrl! }));
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [gens, resultUrls]);

  const promptPreview = useMemo(() => {
    if (!prompt.trim()) return null;
    return buildComplementPrompt(prompt, {
      bpm: trackState.bpm,
      musicalKey: trackState.musical_key,
      scale: trackState.scale,
      camelot: trackState.camelot,
      energy: trackState.energy,
      genre: trackState.genre,
    });
  }, [prompt, trackState]);

  async function fetchIdeas() {
    setIdeasBusy(true);
    setError(null);
    setInfo(null);
    try {
      const resp = await fetch("/api/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysis: {
            bpm: trackState.bpm,
            musicalKey: trackState.musical_key,
            scale: trackState.scale,
            camelot: trackState.camelot,
            energy: trackState.energy,
            durationSec: trackState.duration_sec,
          },
          genre: trackState.genre,
          filename: trackState.filename,
        }),
      });
      const json = (await resp.json()) as { ideas?: Idea[]; error?: string };
      if (!resp.ok) throw new Error(json.error || "No se pudieron generar ideas");
      setIdeas(json.ideas ?? []);
      if (!json.ideas?.length) throw new Error("La IA no devolvió ideas. Inténtalo de nuevo.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setIdeasBusy(false);
    }
  }

  async function generate() {
    const text = prompt.trim();
    if (!text) {
      setError("Escribe qué quieres que añada la IA, o pide ideas primero.");
      return;
    }
    setGenBusy(true);
    setError(null);
    setInfo(null);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Sesión caducada. Vuelve a entrar.");

      const { data: row, error: insErr } = await supabase
        .from("generations")
        .insert({
          track_id: track.id,
          prompt: text,
          idea_source: ideaUsed ? "ai" : "user",
          engine: "musicgen",
          status: "queued",
        })
        .select()
        .single();
      if (insErr) throw new Error(`No se pudo encolar: ${insErr.message}`);

      setGens((prev) => [row as Generation, ...prev]);

      const resp = await fetch("/.netlify/functions/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ generation_id: (row as Generation).id }),
      });
      // Las background functions devuelven 202 de inmediato.
      if (resp.status === 404) {
        throw new Error("Función de generación no desplegada todavía.");
      }
      if (resp.status >= 400 && resp.status !== 202) {
        throw new Error(`No se pudo lanzar la generación (HTTP ${resp.status}).`);
      }
      setInfo(
        "Generación lanzada ⚡ — tarda ~1 minuto. Puedes salir de la página: el estado se guarda en tu cuenta."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setGenBusy(false);
    }
  }

  async function updateGenre(value: string) {
    const genre = value === "Auto" ? null : value;
    setTrackState((prev) => ({ ...prev, genre }));
    const s = createClient();
    const { error: upErr } = await s
      .from("tracks")
      .update({ genre })
      .eq("id", track.id);
    if (upErr) setError(`No se pudo guardar el género: ${upErr.message}`);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-[#0b0d14]/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-3">
          <Link
            href="/"
            className="text-sm text-slate-400 transition hover:text-white"
          >
            ← Biblioteca
          </Link>
          <Link href="/" className="text-lg font-bold text-white">
            Sine<span className="text-indigo-400">AI</span>
          </Link>
          <span className="w-16 text-right text-[10px] text-slate-600">
            v0.1
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-4 py-8">
        <div>
          <h1 className="truncate text-xl font-bold text-white">
            {trackState.filename}
          </h1>
          <p className="text-xs text-slate-500">
            Subida el {new Date(trackState.created_at).toLocaleString("es-ES")}
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* ---------- Pista original + análisis ---------- */}
          <section className="space-y-4 rounded-2xl border border-slate-800 bg-[#111522]/70 p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Pista original
            </h2>

            {sourceUrl ? (
              <audio
                ref={originalAudioRef}
                controls
                src={sourceUrl}
                className="w-full"
                onPlay={() => {
                  // Reproducción individual iniciada por el usuario: si hay
                  // mezcla activa, se corta el complemento y sigue solo la original.
                  if (suppressEventsRef.current) return;
                  if (mixingRef.current) endMix(originalAudioRef.current);
                  pauseOtherGenerations(null);
                }}
                onEnded={() => {
                  // La original manda: al terminar, se corta el bucle del complemento.
                  if (mixingRef.current) endMix(null);
                }}
              />
            ) : (
              <div className="h-10 w-full animate-pulse rounded-lg bg-slate-800/60" />
            )}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="BPM" value={String(Math.round(trackState.bpm ?? 0))} />
              <Stat
                label="Tono"
                value={`${trackState.musical_key ?? "?"} ${
                  trackState.scale === "major" ? "mayor" : "menor"
                }`}
              />
              <Stat label="Camelot" value={trackState.camelot ?? "—"} />
              <Stat label="Energía" value={`${trackState.energy ?? 0}%`} />
              <Stat label="Duración" value={formatDuration(trackState.duration_sec)} />
              <div className="rounded-xl bg-slate-900/70 p-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">
                  Género
                </p>
                <select
                  value={trackState.genre ?? "Auto"}
                  onChange={(e) => void updateGenre(e.target.value)}
                  className="mt-1 w-full bg-transparent text-sm font-semibold text-slate-100 outline-none"
                >
                  {GENRES.map((g) => (
                    <option key={g} value={g} className="bg-slate-900">
                      {g}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {hasDone && (alignReady ? (
              <p className="text-[11px] text-slate-600">
                🎧 Los complementos se sitúan en la sección más estable de tu
                canción
                {sectionStart() > 1
                  ? ` (desde ${formatDuration(sectionStart())})`
                  : ""}
                {" "}y en la mezcla entran alineados a sus compases.
              </p>
            ) : rhythmPending ? (
              <p className="text-[11px] text-slate-600">
                ⏳ Midiendo los compases de tu pista para poder alinear los
                complementos…
              </p>
            ) : null)}

            <p className="text-[11px] text-slate-600">
              Análisis local con essentia.js — tu audio se analiza en tu
              navegador y solo se sube cuando tú lo indicas.
            </p>
          </section>

          {/* ---------- Prompt + ideas + generar ---------- */}
          <section className="space-y-4 rounded-2xl border border-slate-800 bg-[#111522]/70 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Complemento a generar
              </h2>
              <button
                onClick={() => void fetchIdeas()}
                disabled={ideasBusy}
                className="rounded-lg border border-indigo-500/50 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-300 transition hover:bg-indigo-500/20 disabled:opacity-60"
              >
                {ideasBusy ? "Pensando…" : "✨ Dame ideas"}
              </button>
            </div>

            <textarea
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setIdeaUsed(false);
              }}
              rows={4}
              placeholder="Ej.: un bajo analógico suave y unos hi-hats orgánicos que den groove sin quitar protagonismo a la melodía… Si quieres algo protagonista, pídelo explícitamente (p. ej. «un solo de cello que lidere»)."
              className="w-full resize-none rounded-xl border border-slate-700 bg-slate-900/70 p-3 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
            />

            {promptPreview && (
              <p className="rounded-lg bg-slate-950/70 p-2.5 font-mono text-[10px] leading-relaxed text-slate-500">
                🎛 prompt final: {promptPreview}
              </p>
            )}

            {ideas.length > 0 && (
              <div className="space-y-2">
                <p className="text-[11px] font-medium text-slate-500">
                  Ideas de la IA (pulsa una para usarla):
                </p>
                <div className="space-y-1.5">
                  {ideas.map((idea, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        setPrompt(idea.prompt);
                        setIdeaUsed(true);
                        setError(null);
                      }}
                      className={`block w-full rounded-xl border p-3 text-left transition ${
                        prompt === idea.prompt
                          ? "border-indigo-500 bg-indigo-500/10"
                          : "border-slate-800 bg-slate-900/50 hover:border-slate-600"
                      }`}
                    >
                      <span className="block text-sm font-medium text-slate-200">
                        {idea.title}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {idea.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={() => void generate()}
              disabled={genBusy || hasActive}
              className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {genBusy
                ? "Lanzando…"
                : hasActive
                  ? "Ya hay una generación en curso…"
                  : "🎛 Generar complemento"}
            </button>

            {error && (
              <p className="rounded-lg border border-rose-900/60 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
                {error}
              </p>
            )}
            {info && (
              <p className="rounded-lg border border-emerald-900/60 bg-emerald-950/50 px-3 py-2 text-xs text-emerald-300">
                {info}
              </p>
            )}
          </section>
        </div>

        {/* ---------- Generaciones ---------- */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
            Generaciones ({gens.length})
          </h2>
          {gens.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-[#111522]/60 p-8 text-center text-sm text-slate-500">
              Aún no has generado ningún complemento. Escribe un prompt o pide
              ideas a la IA.
            </div>
          ) : (
            <div className="space-y-3">
              {gens.map((g) => (
                <div
                  key={g.id}
                  className="rounded-2xl border border-slate-800 bg-[#111522]/70 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-300">
                      {STATUS_LABEL[g.status]}
                      {g.idea_source === "ai" && (
                        <span className="ml-2 rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] text-indigo-300">
                          idea IA
                        </span>
                      )}
                    </span>
                    <span className="text-[10px] text-slate-600">
                      {new Date(g.created_at).toLocaleString("es-ES")}
                    </span>
                  </div>

                  <p className="mt-2 text-sm text-slate-400">“{g.prompt}”</p>

                  {(g.status === "queued" || g.status === "running") && (
                    <div className="mt-3 flex items-center gap-2">
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
                      <span className="text-xs text-slate-500">
                        {g.status === "queued"
                          ? "Esperando turno en la GPU gratuita…"
                          : "La IA está componiendo tu pista (~1 min)…"}
                      </span>
                    </div>
                  )}

                  {g.status === "done" && resultUrls[g.id] && (
                    <div className="mt-3">
                      <audio
                        ref={(el) => {
                          genAudioRefs.current[g.id] = el;
                        }}
                        controls
                        src={resultUrls[g.id]}
                        className="w-full"
                        onPlay={(e) => {
                          // Reproducción individual iniciada por el usuario.
                          // En modo mezcla, este reproductor ya está sonando:
                          // ignorar los eventos programáticos del arranque.
                          if (suppressEventsRef.current) return;
                          const el = e.currentTarget;
                          if (mixingRef.current) {
                            // Otra mezcla activa: cámbiala por esta escucha individual.
                            endMix(el);
                            return;
                          }
                          originalAudioRef.current?.pause();
                          pauseOtherGenerations(g.id);
                        }}
                        onEnded={() => onComplementEnded(g.id)}
                      />
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <button
                          onClick={() =>
                            mixingId === g.id
                              ? stopMix()
                              : void startMix(g.id)
                          }
                          disabled={syncingId === g.id}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:cursor-wait disabled:opacity-70 ${
                            mixingId === g.id
                              ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                              : "border-slate-700 bg-slate-800/60 text-slate-300 hover:border-slate-500 hover:text-white"
                          }`}
                        >
                          {mixingId === g.id
                            ? "⏹ Parar mezcla"
                            : syncingId === g.id
                              ? "⏳ Sincronizando compases…"
                              : `🎧 Escuchar con la pista original${
                                  sectionStart() > 1
                                    ? ` · desde ${formatDuration(sectionStart())}`
                                    : ""
                                }`}
                        </button>
                        {mixingId === g.id && mixAligned && (
                          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                            ✔ alineado al compás
                          </span>
                        )}
                        {tempoInfo[g.id] && (
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                              tempoInfo[g.id].fits
                                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400/90"
                                : "border-amber-600/40 bg-amber-500/10 text-amber-300"
                            }`}
                            title={
                              tempoInfo[g.id].fits
                                ? "El tempo del complemento se corrige en la mezcla sin alterar el tono"
                                : "El complemento quedó en otro tempo; en la mezcla entra alineado al compás"
                            }
                          >
                            {tempoInfo[g.id].fits
                              ? `tempo ✔ ${tempoInfo[g.id].complementBpm.toFixed(1)} BPM`
                              : `tempo ⚠ ${tempoInfo[g.id].complementBpm.toFixed(1)} BPM${
                                  tempoInfo[g.id].relation
                                    ? ` · ${tempoInfo[g.id].relation}`
                                    : ""
                                }`}
                          </span>
                        )}
                        {mixingId === g.id && (
                          <label className="flex items-center gap-2 text-[11px] text-slate-500">
                            Volumen del complemento
                            <input
                              type="range"
                              min={0}
                              max={100}
                              value={Math.round(mixVolume * 100)}
                              onChange={(e) =>
                                changeMixVolume(Number(e.target.value) / 100)
                              }
                              className="w-24 accent-indigo-500"
                            />
                          </label>
                        )}
                        <a
                          href={resultUrls[g.id]}
                          download={`${trackState.filename.replace(/\.[^.]+$/, "")} - complemento.${(g.result_path ?? "gen.aac").split(".").pop() ?? "aac"}`}
                          className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
                        >
                          ⬇ Descargar
                        </a>
                      </div>
                      {mixingId === g.id && tempoWarn[g.id] && (
                        <p className="mt-2 rounded-lg border border-amber-800/50 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-300">
                          ⚠ {tempoWarn[g.id]}
                        </p>
                      )}
                      {mixingId === g.id && (
                        <p className="mt-2 text-[11px] text-slate-500">
                          {mixAligned
                            ? `🎧 Mezcla activa — la original arranca en su sección${
                                sectionStart() > 1
                                  ? ` (${formatDuration(sectionStart())})`
                                  : ""
                              } y el complemento entra en el mismo compás; cada vuelta se reinicia en el beat siguiente hasta que pulses parar.`
                            : "🎧 Mezcla activa — suenan a la vez y en bucle hasta que pulses parar. Ajusta el volumen para equilibrar el balance."}
                        </p>
                      )}
                    </div>
                  )}

                  {g.status === "error" && (
                    <p className="mt-3 rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
                      {g.error ?? "Error desconocido"}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-900/70 p-3">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-slate-100">{value}</p>
    </div>
  );
}

function formatDuration(sec: number | null): string {
  if (!sec || !Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
