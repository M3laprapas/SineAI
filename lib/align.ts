// Alineación musical entre la pista original y el complemento generado.
//
// El motor (MusicGen por texto) no escucha la pista: genera "a ciegas", así
// que medimos después lo que sí decide si suena bien JUNTO a la original:
// 1. La rejilla de compases de ambos audios — arrancando cada uno EXACTAMENTE
//    en un compás y al mismo instante, las rejillas quedan sincronizadas.
// 2. El tempo real de cada audio — el modelo y el detector son ambiguos en
//    octava, así que buscamos la relación musical (×2, ×0.5…) y corregimos
//    la velocidad solo si el ajuste no deforma la afinación.
// 3. La sección de la canción donde el complemento tiene su lugar.

export const COMPLEMENT_SECONDS = 20;

/**
 * El modelo no obedece el BPM textual, y además el detector de ritmo es
 * ambiguo en octava (mide 155 BPM donde el pulso real es 77.7). Por eso no
 * comparamos BPM crudos: probamos TODAS las relaciones musicales sencillas
 * (incluidas ×2 y ×0.5 en ambos sentidos) y elegimos la que deja el
 * complemento en el tempo de la pista con menos desviación.
 *
 * La tolerancia es amplia a propósito: el modelo suele caer a un 3-8 % del
 * tempo (≈1-1.5 semitonos), y ajustar ese resto con la velocidad exacta deja
 * la mezcla clavada sin deriva. Solo avisamos cuando NO hay relación posible.
 */
const TEMPO_TOLERANCE_BPM = 12;
const TEMPO_RELATIONS: Array<{ label: string; ratio: number }> = [
  { label: "igual tempo (×1)", ratio: 1 },
  { label: "la mitad (×0.5)", ratio: 0.5 },
  { label: "el doble (×2)", ratio: 2 },
  { label: "dos tercios (×0.667)", ratio: 2 / 3 },
  { label: "tres medios (×1.5)", ratio: 1.5 },
  { label: "un tercio (×0.333)", ratio: 1 / 3 },
  { label: "el triple (×3)", ratio: 3 },
  { label: "tres cuartos (×0.75)", ratio: 0.75 },
  { label: "cuatro tercios (×1.333)", ratio: 4 / 3 },
];

export interface ComplementTempoPlan {
  /** Velocidad de reproducción a aplicar (1 = sin cambio). */
  rate: number;
  /** BPM efectivo tras aplicar `rate`. */
  adjustedBpm: number;
  /** Desviación restante en BPM (menor = mejor encaje). */
  delta: number;
  /** Relación musical detectada, p. ej. "la mitad (×0.5)". */
  relation: string;
  /** Semitonos de cambio de tono que implica `rate` (negativo = más grave). */
  semitones: number;
}

const cents = (rate: number) => 1200 * Math.log2(rate);
const fmtSemis = (semitones: number) =>
  Math.abs(semitones) < 0.05
    ? "sin cambio de tono"
    : `${semitones > 0 ? "sube" : "baja"} ≈ ${Math.abs(semitones).toFixed(1)} semitonos`;

/**
 * Corrige la velocidad del complemento para clavarlo en el tempo de la pista.
 *
 * Límite de honestidad: cambiar la velocidad también cambia el tono (≈1
 * semitono por cada 6 %). Si la corrección necesaria pasa de `MAX_SEMITONES`,
 * devolvemos `null` — preferimos avisar de que el tempo no encaja antes que
 * deformar el audio y romper la afinación.
 */
const MAX_SEMITONES = 0.7;

export function planTempo(
  originalBpm: number,
  complementBpm: number,
  toleranceBpm = TEMPO_TOLERANCE_BPM
): ComplementTempoPlan | null {
  if (!(originalBpm > 0) || !(complementBpm > 0)) return null;
  let best: { relation: string; delta: number } | null = null;
  for (const rel of TEMPO_RELATIONS) {
    const delta = Math.abs(complementBpm * rel.ratio - originalBpm);
    if (!best || delta < best.delta) best = { relation: rel.label, delta };
  }
  if (!best || best.delta > toleranceBpm) return null;

  // Velocidad exacta que clava el tempo (no la de la relación aproximada).
  const rate = originalBpm / complementBpm;
  const semitones = cents(rate) / 100;
  if (Math.abs(semitones) > MAX_SEMITONES) return null;
  return {
    rate,
    adjustedBpm: complementBpm * rate,
    delta: 0,
    relation: best.relation,
    semitones,
  };
}

export function describeTempoPlan(plan: ComplementTempoPlan): string {
  return `${plan.relation}, corregido a ${plan.rate.toFixed(3)}× (${fmtSemis(plan.semitones)})`;
}

export interface TempoDiagnosis {
  /** Relación musical sencilla más cercana, si existe. */
  relation: string | null;
  /** BPM que tendría el complemento con esa relación aplicada. */
  relatedBpm: number | null;
  /** Desviación restante en BPM respecto al tempo de la pista. */
  residualBpm: number;
  /** Velocidad que clavaría el tempo exacto (puede ser extrema). */
  exactRate: number;
  /** Semitonos que implicaría `exactRate`. */
  exactSemitones: number;
}

/**
 * Diagnóstico legible del desajuste de tempo: reconoce la relación musical
 * más plausible aunque la corrección sea demasiado agresiva para aplicarla.
 */
export function diagnoseTempo(
  originalBpm: number,
  complementBpm: number
): TempoDiagnosis {
  let best: { relation: string; delta: number } | null = null;
  for (const rel of TEMPO_RELATIONS) {
    const delta = Math.abs(complementBpm * rel.ratio - originalBpm);
    if (!best || delta < best.delta) best = { relation: rel.label, delta };
  }
  const exactRate = complementBpm > 0 ? originalBpm / complementBpm : 1;
  const recognized = best && best.delta <= TEMPO_TOLERANCE_BPM;
  return {
    relation: recognized ? best!.relation : null,
    relatedBpm: recognized ? complementBpm : null,
    residualBpm: best ? best.delta : Math.abs(originalBpm - complementBpm),
    exactRate,
    exactSemitones: cents(exactRate) / 100,
  };
}

export interface RhythmGrid {
  bpm: number;
  /** Instantes (s) de los compases medidos. */
  beats: number[];
}

/**
 * Primer compás en o después de `t`. Si `t` queda más allá de los compases
 * medidos (RhythmExtractor cubre ~120 s), extrapola la rejilla con el periodo
 * medio del tempo.
 */
export function beatAtOrAfter(grid: RhythmGrid, t: number): number {
  const { beats, bpm } = grid;
  if (!beats.length || !(bpm > 0)) return t;
  const last = beats[beats.length - 1];
  if (t <= last) {
    let lo = 0;
    let hi = beats.length - 1;
    let ans = last;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] >= t - 1e-4) {
        ans = beats[mid];
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return ans;
  }
  const period = 60 / bpm;
  const k = Math.ceil((t - last) / period);
  return last + k * period;
}

/**
 * Dónde arrancar cada audio de la mezcla para que ambos caigan en compás:
 * - `originalStart`: el primer compás de la original en o después de la
 *   sección elegida (el complemento pertenece ahí).
 * - `complementStart`: el primer compás del complemento (salta su arranque
 *   suelto para que el downbeat coincida).
 */
export function alignStarts(
  orig: RhythmGrid,
  comp: RhythmGrid,
  targetSec: number
): { originalStart: number; complementStart: number } {
  const originalStart = beatAtOrAfter(orig, Math.max(0, targetSec));
  // Un primer compás lejano (>5 s) indica medida fiable → recortar; si no, 0.
  const complementStart =
    comp.beats.length && comp.beats[0] < 5 ? comp.beats[0] : 0;
  return { originalStart, complementStart };
}
