import { createClient } from "@/lib/supabase/server";
import { keyLabel, genreEn, type AnalysisContext } from "@/lib/prompt";

// Orden por fiabilidad probada con cuenta nueva (oct-2026): el alias "lite"
// responde (~18 s); los modelos "flash" completos agotan 60-90 s. Los aliases
// "-latest" siempre apuntan al flash vigente.
const MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-3.8-flash"];

interface IdeasBody {
  analysis?: AnalysisContext & { musicalKey?: string | null };
  genre?: string | null;
  filename?: string | null;
}

function buildIdeasPrompt(body: IdeasBody): string {
  const a = body.analysis ?? {};
  const facts: string[] = [];

  if (a.bpm && a.bpm > 0) facts.push(`- BPM: ${Math.round(a.bpm)}`);
  const key = keyLabel(a);
  if (key) facts.push(`- Tono: ${key}${a.camelot && a.camelot !== "—" ? ` (Camelot ${a.camelot})` : ""}`);
  if (a.energy != null) facts.push(`- Energía: ${a.energy}/100`);
  if (a.durationSec) facts.push(`- Duración: ${Math.round(a.durationSec)} s`);
  const genre = genreEn(body.genre) ?? body.genre;
  if (genre && genre !== "Auto") facts.push(`- Género: ${genre}`);
  if (body.filename) facts.push(`- Nombre del fichero: ${body.filename}`);

  return `Eres un productor musical experto en arreglos y composición. Un usuario tiene una pista instrumental y quiere ideas de pistas secundarias que la complementen (bajo, pads, percusión, texturas, arpegios…).

Datos reales de la pista (detectados con análisis de audio):
${facts.join("\n") || "- (sin análisis disponible)"}

Genera 5 ideas variadas y creativas que ENCAJEN con esos datos. Filosofía clave: el complemento es una capa de APOYO — debe quedar detrás en la mezcla, dejar espacio a los elementos principales de la pista original y no robarle el protagonismo. Eso se refleja en el texto de cada prompt (p. ej. "sits behind the main melody", "gentle supporting texture", "does not dominate the mix"); solo describe una parte prominente o protagonista si el título de la idea lo pide explícitamente (p. ej. "un solo protagonista"). Además, cada idea debe ser SIMPLE y fácil de integrar: texturas esparsas (notas largas sostenidas, un patrón repetitivo mínimo, sub bajo, percusión discreta), fácil de loopar y sin carreras melódicas ocupadas que choquen con la pista original.

Devuelve SOLO JSON válido, sin markdown, con esta forma exacta:
{"ideas":[{"title":"nombre corto creativo en español","description":"una frase en español explicando por qué encaja con la pista","prompt":"instrucción concreta EN INGLÉS para el generador de música: instrumento/textura/rol arreglístico, con el BPM exacto y el tono exacto si los conoces (p. ej. '124 BPM, key F# minor'). Indica que es una capa de apoyo que no domina la mezcla y que debe ser simple, esparsa y fácil de loopar. Solo capas instrumentales, sin vocals."}]}`;
}

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "No autenticado" }, { status: 401 });
  }

  // Nota: NO usar el nombre "GEMINI_API_KEY" — `netlify dev` inyecta su propio
  // JWT de sesión del CLI bajo ese nombre y pisa la key real (las variables del
  // sitio y .env.local se ven afectadas en local). Usamos un nombre propio.
  const apiKey = process.env.GOOGLE_GEMINI_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error:
          "Las ideas de IA no están configuradas aún (falta la API key de Gemini).",
      },
      { status: 503 }
    );
  }

  let body: IdeasBody = {};
  try {
    body = (await req.json()) as IdeasBody;
  } catch {
    return Response.json({ error: "Cuerpo inválido" }, { status: 400 });
  }

  const prompt = buildIdeasPrompt(body);

  let lastError = "No se pudieron generar ideas.";
  for (const model of MODELS) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.9,
              responseMimeType: "application/json",
            },
          }),
          signal: AbortSignal.timeout(75000),
        }
      );

      if (resp.status === 429) {
        return Response.json(
          {
            error:
              "Límite gratuito de Gemini alcanzado. Prueba de nuevo en unos minutos.",
          },
          { status: 429 }
        );
      }
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.error(`[ideas] ${model} → HTTP ${resp.status}: ${errText.slice(0, 250)}`);
        lastError = `Gemini ${model} respondió ${resp.status}: ${errText.slice(0, 200)}`;
        if (resp.status === 404) continue; // modelo no disponible → siguiente
        if (resp.status === 400 || resp.status === 403) {
          return Response.json(
            { error: "API key de Gemini inválida o sin permisos." },
            { status: 502 }
          );
        }
        continue;
      }

      const json = (await resp.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const cleaned = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      const parsed = JSON.parse(cleaned) as { ideas?: unknown };
      const ideas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
      if (ideas.length === 0) throw new Error("Respuesta vacía");
      return Response.json({ ideas });
    } catch (e) {
      if (e instanceof SyntaxError) {
        lastError = "La IA devolvió un formato inesperado. Inténtalo de nuevo.";
      } else if (e instanceof Error && e.name === "TimeoutError") {
        lastError = "Gemini tardó demasiado. Inténtalo de nuevo.";
      } else if (e instanceof Error && e.message !== "Respuesta vacía") {
        lastError = e.message;
      }
      // siguiente modelo
    }
  }

  return Response.json({ error: lastError }, { status: 502 });
}
