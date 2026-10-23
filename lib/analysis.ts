// Análisis de audio en el navegador con essentia.js (WASM) vía CDN.
// Todo local y gratuito: BPM, tono, Camelot, energía, duración, compases y
// la sección representativa donde encaja un complemento.

export interface TrackAnalysis {
  bpm: number;
  bpmConfidence: number;
  musicalKey: string; // p. ej. "F#"
  scale: string; // "major" | "minor"
  camelot: string; // p. ej. "11A"
  energy: number; // 0-100 (RMS)
  durationSec: number;
  beats: number[]; // instantes (s) de los primeros compases medidos
  sectionStartSec: number; // inicio (s) de la mejor ventana para un complemento
}

/** Ritmo medido de un audio (pista original o complemento generado). */
export interface MeasuredRhythm {
  bpm: number;
  beats: number[];
  durationSec: number;
  sectionStartSec: number;
}

const ESSENTIA_VERSION = "0.1.3";
const CDN = `https://cdn.jsdelivr.net/npm/essentia.js@${ESSENTIA_VERSION}/dist`;

// Rueda Camelot — cubre nombres con sostenidos y bemoles (devuelve "—" si es desconocido)
const CAMELOT: Record<string, string> = {
  "C major": "8B", "G major": "9B", "D major": "10B", "A major": "11B",
  "E major": "12B", "B major": "1B", "F# major": "2B", "Gb major": "2B",
  "Db major": "3B", "C# major": "3B", "Ab major": "4B", "G# major": "4B",
  "Eb major": "5B", "D# major": "5B", "Bb major": "6B", "A# major": "6B",
  "F major": "7B",
  "A minor": "8A", "E minor": "9A", "B minor": "10A", "F# minor": "11A",
  "Gb minor": "11A", "C# minor": "12A", "Db minor": "12A", "G# minor": "1A",
  "Ab minor": "1A", "D# minor": "2A", "Eb minor": "2A", "Bb minor": "3A",
  "A# minor": "3A", "F minor": "4A", "C minor": "5A", "G minor": "6A",
  "D minor": "7A",
};

export function toCamelot(key: string, scale: string): string {
  return CAMELOT[`${key} ${scale}`] ?? "—";
}

let essentiaPromise: Promise<Record<string, unknown>> | null = null;

function loadEssentia(): Promise<Record<string, unknown>> {
  if (essentiaPromise) return essentiaPromise;

  essentiaPromise = new Promise((resolve, reject) => {
    const fail = (err: unknown) => {
      essentiaPromise = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const core = document.createElement("script");
    core.src = `${CDN}/essentia.js-core.umd.js`;
    core.async = true;
    core.onerror = () => fail(new Error("No se pudo cargar essentia.js (¿sin conexión?)"));

    core.onload = () => {
      const wasm = document.createElement("script");
      wasm.src = `${CDN}/essentia-wasm.web.js`;
      wasm.async = true;
      wasm.onerror = () => fail(new Error("No se pudo cargar el módulo WASM de essentia"));
      wasm.onload = async () => {
        try {
          const g = window as unknown as {
            Essentia?: new (mod: unknown) => Record<string, unknown>;
            EssentiaWASM?: () => Promise<unknown>;
          };
          if (!g.Essentia || !g.EssentiaWASM) {
            throw new Error("essentia.js no expone sus globales esperados");
          }
          const module = await g.EssentiaWASM();
          resolve(new g.Essentia(module));
        } catch (err) {
          fail(err);
        }
      };
      document.head.appendChild(wasm);
    };

    document.head.appendChild(core);
  });

  return essentiaPromise;
}

interface EssentiaAPI {
  audioBufferToMonoSignal: (buffer: AudioBuffer) => Float32Array;
  arrayToVector: (arr: Float32Array) => unknown;
  // essentia.js core expone los instantes de compás como `ticks`
  // (VectorFloat de emscripten: size()/get(i), sin length ni índices).
  RhythmExtractor2013: (v: unknown) => {
    bpm: number;
    confidence: number;
    ticks?: unknown;
    beats?: unknown;
  };
  KeyExtractor: (v: unknown) => { key: string; scale: string; strength: number };
}

function beatsToArray(rhythm: { ticks?: unknown; beats?: unknown }): number[] {
  const raw = (rhythm.ticks ?? rhythm.beats) as
    | ArrayLike<number>
    | { size(): number; get(i: number): number }
    | undefined
    | null;
  if (!raw) return [];
  try {
    let arr: number[];
    if (typeof (raw as { size?: unknown }).size === "function") {
      const v = raw as { size(): number; get(i: number): number };
      arr = Array.from({ length: v.size() }, (_, i) => v.get(i));
    } else if (typeof (raw as ArrayLike<number>).length === "number") {
      arr = Array.from(raw as ArrayLike<number>);
    } else {
      return [];
    }
    return arr
      .map((b) => Math.round(Number(b) * 1000) / 1000)
      .filter((b) => Number.isFinite(b) && b >= 0);
  } catch {
    return [];
  }
}

/**
 * Elige el inicio (s) de la mejor ventana de ~20 s para un complemento:
 * energía alta y ESTABLE (el estribillo/tornada típica), evitando el intro.
 * Trabaja sobre RMS en hops de 0,5 s — bucle JS, instantáneo.
 */
export function pickSection(
  mono: Float32Array,
  sampleRate: number,
  wantSec = 20
): number {
  const hop = Math.max(1, Math.floor(sampleRate * 0.5));
  const winHops = Math.max(2, Math.round(wantSec / 0.5));
  const maxHops = Math.min(Math.floor(mono.length / hop), 240); // primeros 120 s
  if (maxHops < winHops) return 0;

  const rms: number[] = [];
  for (let h = 0; h < maxHops; h++) {
    let s = 0;
    const off = h * hop;
    for (let i = 0; i < hop; i += 4) {
      const v = mono[off + i];
      s += v * v;
    }
    rms.push(Math.sqrt(s / (hop / 4)));
  }

  // No elegir dentro del primer ~15 % (intro).
  const minStart = Math.min(Math.floor(maxHops * 0.15), rms.length - winHops);
  let bestStart = Math.max(0, minStart);
  let bestScore = -Infinity;
  for (let h = Math.max(0, minStart); h + winHops <= rms.length; h++) {
    const seg = rms.slice(h, h + winHops);
    const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
    const std = Math.sqrt(
      seg.reduce((a, b) => a + (b - mean) * (b - mean), 0) / seg.length
    );
    const score = mean - 0.5 * std; // energía alta y estable
    if (score > bestScore) {
      bestScore = score;
      bestStart = h * 0.5;
    }
  }
  return Math.round(bestStart * 100) / 100;
}

async function decodeAudioFromBuffer(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } catch {
    throw new Error(
      "No se pudo decodificar el audio. Formatos admitidos: MP3, WAV, FLAC, OGG, M4A…"
    );
  } finally {
    ctx.close().catch(() => {});
  }
}

/** Analiza un fichero de audio completo. Puede tardar varios segundos en pistas largas. */
export async function analyzeAudio(file: File): Promise<TrackAnalysis> {
  const essentia = (await loadEssentia()) as unknown as EssentiaAPI;

  const arrayBuffer = await file.arrayBuffer();
  const buffer = await decodeAudioFromBuffer(arrayBuffer);

  const mono = essentia.audioBufferToMonoSignal(buffer);

  // Energía (RMS) sobre la pista completa — bucle JS, instantáneo
  let sumSquares = 0;
  for (let i = 0; i < mono.length; i++) sumSquares += mono[i] * mono[i];
  const rms = Math.sqrt(sumSquares / Math.max(1, mono.length));

  // BPM y tono: sobre los primeros 120 s es suficiente y mantiene la UI fluida
  const sampleRate = buffer.sampleRate;
  const analysisLen = Math.min(mono.length, sampleRate * 120);
  const sample = analysisLen === mono.length ? mono : mono.subarray(0, analysisLen);
  const vec = essentia.arrayToVector(sample);

  const rhythm = essentia.RhythmExtractor2013(vec);
  const key = essentia.KeyExtractor(vec);

  return {
    bpm: Math.round(rhythm.bpm * 10) / 10,
    bpmConfidence: Number.isFinite(rhythm.confidence) ? rhythm.confidence : 0,
    musicalKey: key.key,
    scale: key.scale,
    camelot: toCamelot(key.key, key.scale),
    energy: Math.max(0, Math.min(100, Math.round(rms * 100))),
    durationSec: Math.round(buffer.duration * 10) / 10,
    beats: beatsToArray(rhythm),
    sectionStartSec: pickSection(mono, sampleRate, 20),
  };
}

/**
 * Analiza solo el ritmo de un audio remoto (p. ej. un complemento generado):
 * BPM, compases, duración y su sección representativa. Usado para alinear el
 * complemento con la pista original en la mezcla.
 */
export async function analyzeRhythmFromUrl(url: string): Promise<MeasuredRhythm> {
  const essentia = (await loadEssentia()) as unknown as EssentiaAPI;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar el audio (HTTP ${res.status})`);
  const buffer = await decodeAudioFromBuffer(await res.arrayBuffer());

  const mono = essentia.audioBufferToMonoSignal(buffer);
  const sampleRate = buffer.sampleRate;
  const analysisLen = Math.min(mono.length, sampleRate * 120);
  const sample = analysisLen === mono.length ? mono : mono.subarray(0, analysisLen);
  const rhythm = essentia.RhythmExtractor2013(essentia.arrayToVector(sample));

  return {
    bpm: Math.round(rhythm.bpm * 10) / 10,
    beats: beatsToArray(rhythm),
    durationSec: Math.round(buffer.duration * 10) / 10,
    sectionStartSec: pickSection(mono, sampleRate, 20),
  };
}
