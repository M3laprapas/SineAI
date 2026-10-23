import type { Config, Context } from "@netlify/functions";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "@gradio/client";
import { buildComplementPrompt, type AnalysisContext } from "../../lib/prompt";
import { COMPLEMENT_SECONDS } from "../../lib/align";

// Background function: el cliente recibe 202 de inmediato y el trabajo
// (IA + subida del resultado) corre hasta 15 min en segundo plano.
export const config: Config = { background: true };

// Motor: musicgen-streaming (ZeroGPU, A10G) — el espacio oficial facebook/MusicGen
// rechaza las cuentas gratuitas ("ZeroGPU client error"); este espacio sí acepta
// tokens de cuenta gratuita y genera ~3× más rápido. Devuelve stream HLS (.aac
// ADTS) que reconstruimos aquí en un único fichero AAC reproducible en navegador.
const MUSICGEN_SPACE = "sanchit-gandhi/musicgen-streaming";

interface GenerationRow {
  id: string;
  user_id: string;
  track_id: string;
  prompt: string;
  status: string;
  result_path: string | null;
  track: {
    filename: string;
    storage_path: string;
    mime_type: string | null;
    bpm: number | null;
    musical_key: string | null;
    scale: string | null;
    camelot: string | null;
    energy: number | null;
    genre: string | null;
  } | null;
}

function friendlyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.toLowerCase();
  if (m.includes("hf_token no configurado"))
    return "Falta configurar HF_TOKEN en las variables de entorno de Netlify.";
  if (
    m.includes("quota") ||
    m.includes("gpu") ||
    m.includes("exceeded") ||
    m.includes("rate limit") ||
    m.includes("daily")
  )
    return "Cuota diaria gratuita de GPU agotada (~5 min/día). Vuelve a intentarlo mañana o prueba más tarde.";
  if (
    m.includes("internal gradio error") ||
    m.includes("event: error")
  )
    return "El modelo devolvió un error interno (suele ser la cuota de GPU agotada o el espacio saturado). Prueba de nuevo en unos minutos.";
  if (
    m.includes("401") ||
    m.includes("403") ||
    m.includes("unauthorized") ||
    m.includes("token")
  )
    return "Token de HuggingFace inválido (revisa HF_TOKEN en Netlify).";
  return `Error generando: ${raw}`.slice(0, 400);
}

// El playlist HLS se sirve con ENDLIST al terminar la generación; si aún
// estuviera en streaming, esperamos y reintentamos un par de veces.
async function fetchPlaylist(url: string): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const text = await res.text();
      if (text.includes("#EXT-X-ENDLIST")) return text;
      last = text;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

async function setStatus(
  db: SupabaseClient,
  id: string,
  fields: Record<string, unknown>
) {
  await db
    .from("generations")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);
}

export default async function handler(
  req: Request,
  _context: Context
): Promise<Response> {
  // --- Validación temprana (antes de que el runtime descarte la respuesta) ---
  const authHeader = req.headers.get("authorization") ?? "";
  let generationId: string | null = null;
  try {
    const body = (await req.json()) as { generation_id?: string };
    generationId = body.generation_id ?? null;
  } catch {
    /* se gestiona abajo */
  }
  if (!generationId || !authHeader.startsWith("Bearer ")) {
    return new Response("Falta generation_id o token de sesión", { status: 400 });
  }

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON) {
    console.error("[generate] faltan variables NEXT_PUBLIC_SUPABASE_*");
    return new Response("env missing", { status: 500 });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });

  try {
    const { data: gen, error: genErr } = await db
      .from("generations")
      .select("*, track:tracks(*)")
      .eq("id", generationId)
      .single<GenerationRow>();

    if (genErr || !gen || !gen.track) {
      console.error("[generate] no encontrado:", genErr?.message);
      return new Response("not found", { status: 404 });
    }
    if (gen.status === "done") return new Response("already done");

    const track = gen.track;
    await setStatus(db, gen.id, { status: "running" });

    const hfToken = process.env.HF_TOKEN;
    if (!hfToken) throw new Error("HF_TOKEN no configurado");

    // 1) Prompt anclado al análisis real de la pista
    const analysis: AnalysisContext = {
      bpm: track.bpm,
      musicalKey: track.musical_key,
      scale: track.scale,
      camelot: track.camelot,
      energy: track.energy,
      genre: track.genre,
    };
    const texts = buildComplementPrompt(gen.prompt, analysis);

    console.log(
      `[generate] ${gen.id} → MusicGen | ${texts.slice(0, 160)}…`
    );

    // 2) Llamar al space en ZeroGPU. Args posicionales:
    //    [prompt, segundos de audio, intervalo de streaming, semilla]
    const client = await Client.connect(MUSICGEN_SPACE, {
      token: hfToken as `hf_${string}`,
    });
    const seed = Math.min(10, Math.floor(Math.random() * 11));
    const result = (await client.predict("/generate_audio", [
      texts,
      COMPLEMENT_SECONDS,
      2,
      seed,
    ])) as { data?: unknown[] } | undefined;

    const first = (Array.isArray(result?.data) ? result.data : [])[0] as
      | { url?: string; path?: string }
      | string
      | undefined;
    const playlistUrl = typeof first === "string" ? first : first?.url;
    if (!playlistUrl) {
      throw new Error(
        `El modelo no devolvió audio: ${JSON.stringify(first ?? null).slice(0, 200)}`
      );
    }

    // 3) Reconstruir el stream HLS → un único fichero AAC. Los segmentos son
    //    ADTS (cabeceras 0xFFF) y concatenados forman un stream AAC válido,
    //    reproducible nativamente en el navegador y descargable.
    const playlist = await fetchPlaylist(playlistUrl);
    const segUrls = playlist
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => new URL(l, playlistUrl).toString());
    if (segUrls.length === 0)
      throw new Error("El stream de audio no contenía segmentos");

    const chunks: Uint8Array[] = [];
    for (const segUrl of segUrls) {
      const segRes = await fetch(segUrl);
      if (!segRes.ok)
        throw new Error(`Descarga de segmento falló (HTTP ${segRes.status})`);
      chunks.push(new Uint8Array(await segRes.arrayBuffer()));
    }
    const outBuf = Buffer.concat(chunks);
    const outMime = "audio/aac";
    const ext = "aac";

    // 4) Subir resultado al bucket de generaciones (carpeta propia → RLS)
    const destPath = `${gen.user_id}/${gen.id}.${ext}`;
    const { error: upErr } = await db.storage
      .from("generations")
      .upload(destPath, outBuf, { contentType: outMime, upsert: true });
    if (upErr) throw new Error(`No se pudo subir el resultado: ${upErr.message}`);

    // 5) Marcar como lista
    await setStatus(db, gen.id, {
      status: "done",
      result_path: destPath,
      error: null,
      result_meta: { space: MUSICGEN_SPACE, playlist_url: playlistUrl, ext },
    });
    console.log(`[generate] ${gen.id} ✓ done (${outBuf.byteLength} bytes)`);
    return new Response("ok");
  } catch (e) {
    const msg = friendlyError(e);
    console.error(`[generate] ${generationId} ✗`, e);
    try {
      await setStatus(db, generationId, { status: "error", error: msg });
    } catch (dbErr) {
      console.error("[generate] no se pudo marcar el error:", dbErr);
    }
    return new Response(msg, { status: 500 });
  }
}
