// Contexto musical y construcción de prompts para el motor de generación.
// Usado por el cliente (UI) y por la función background de Netlify.

export interface AnalysisContext {
  bpm?: number | null;
  musicalKey?: string | null;
  scale?: string | null;
  camelot?: string | null;
  energy?: number | null;
  genre?: string | null;
  durationSec?: number | null;
}

export function keyLabel(a: AnalysisContext): string | null {
  if (!a.musicalKey || !a.scale) return null;
  const scale = a.scale === "major" ? "major" : "minor";
  return `${a.musicalKey} ${scale}`;
}

const GENRE_EN: Record<string, string> = {
  Rock: "rock",
  Pop: "pop",
  "Hip-Hop / Rap": "hip-hop",
  "Lo-Fi": "lo-fi hip-hop",
  House: "house",
  Techno: "techno",
  Trance: "trance",
  EDM: "EDM",
  Reggaetón: "reggaeton",
  "Urbano Latino": "latin urban",
  Jazz: "jazz",
  Blues: "blues",
  Clásica: "classical",
  Cinematográfica: "cinematic score",
  Ambient: "ambient",
  Metal: "metal",
  Indie: "indie",
  "R&B / Soul": "R&B soul",
  Funk: "funk",
  Disco: "disco",
  Country: "country",
  Reggae: "reggae",
  Folk: "folk",
  Electrónica: "electronic",
};

export function genreEn(genre?: string | null): string | null {
  if (!genre || genre === "Otro" || genre === "Auto") return null;
  return GENRE_EN[genre] ?? genre.toLowerCase();
}

export const GENRES = [
  "Auto",
  "Rock",
  "Pop",
  "Hip-Hop / Rap",
  "Lo-Fi",
  "House",
  "Techno",
  "Trance",
  "EDM",
  "Electrónica",
  "Reggaetón",
  "Urbano Latino",
  "Jazz",
  "Blues",
  "Clásica",
  "Cinematográfica",
  "Ambient",
  "Metal",
  "Indie",
  "R&B / Soul",
  "Funk",
  "Disco",
  "Country",
  "Reggae",
  "Folk",
  "Otro",
];

// Filosofía del producto: el complemento es una capa de APOYO — enriquece la
// pista original sin robarle el protagonismo. Solo pasa a primer plano si el
// usuario lo pide explícitamente ("que lidere", "un solo protagonista"…).
// Cuidado con frases negadas ("sin quitar protagonismo"): cuentan como apoyo.
const PROMINENT_RE =
  /\b(lider\w*|protagonis\w*|domin\w*|destac\w*|principal\w*|primer plano|al frente|prominent|dominant|foreground|in the front|take over|main (?:melody|theme|lead|instrument))\b/i;
const NEGATED_PROMINENCE_RE =
  /\b(sin\s+(?:quitar\w*|robar\w*|llevarse\w*|dominar\w*|restar\w*|competir\w*)|no\s+(?:la\s+|lo\s+|las\s+|les\s+)?(?:robe\w*|domine\w*|lleve\w*|quite\w*|compita\w*)|without\s+(?:stealing\w*|taking\w*|dominating\w*|overpowering\w*|competing\w*))\b/i;

/**
 * Construye el prompt en inglés que recibirá el modelo, anclando el resultado
 * al análisis real de la pista del usuario (BPM, tono, energía…).
 */
export function buildComplementPrompt(
  userPrompt: string,
  analysis: AnalysisContext
): string {
  const parts: string[] = [];

  const base = userPrompt.trim().replace(/\s+/g, " ");
  parts.push(base || "subtle complementary instrumental layer");

  const genre = genreEn(analysis.genre);
  if (genre) parts.push(`${genre} style`);

  if (analysis.bpm && analysis.bpm > 0) {
    const bpm = Math.round(analysis.bpm);
    // MusicGen ignora "exactly N BPM" (verificado: pide 87 y entrega 155).
    // Le damos el pulso como tempo musical y negamos sus variantes típicas
    // (mitad/doble), que es lo que sí parece influir en la salida.
    parts.push(
      `steady ${bpm} BPM tempo, constant pulse at ${bpm} BPM, never half-time (${Math.round(bpm / 2)} BPM) and never double-time (${bpm * 2} BPM)`
    );
  }

  const key = keyLabel(analysis);
  if (key) parts.push(`in the key of ${key}${analysis.camelot && analysis.camelot !== "—" ? ` (${analysis.camelot})` : ""}`);

  if (analysis.energy != null) {
    if (analysis.energy >= 60) parts.push("high energy, driving");
    else if (analysis.energy >= 30) parts.push("medium energy, balanced");
    else parts.push("soft, mellow and spacious");
  }

  const wantsProminent =
    PROMINENT_RE.test(base) && !NEGATED_PROMINENCE_RE.test(base);
  parts.push(
    wantsProminent
      ? "the user explicitly asks for a prominent part: this element leads and sits in the foreground of the mix, instrumental, no vocals"
      : "a supporting complementary layer that enriches without dominating: keep it simple and sparse — long sustained notes or one minimal repeating pattern, plenty of silence between phrases, easy to loop; no busy melodic runs or competing riffs; leaves space for the original track's main elements, sits behind in the mix, never steals the spotlight, instrumental, no vocals"
  );

  return parts.join(", ");
}
