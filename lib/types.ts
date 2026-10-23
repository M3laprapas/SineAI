export interface Track {
  id: string;
  user_id: string;
  filename: string;
  storage_path: string;
  mime_type: string | null;
  duration_sec: number | null;
  bpm: number | null;
  musical_key: string | null;
  scale: string | null;
  camelot: string | null;
  energy: number | null;
  genre: string | null;
  analysis: Record<string, unknown> | null;
  created_at: string;
}

export type GenerationStatus = "queued" | "running" | "done" | "error";

export interface Generation {
  id: string;
  user_id: string;
  track_id: string;
  prompt: string;
  idea_source: "user" | "ai";
  engine: string;
  status: GenerationStatus;
  error: string | null;
  result_path: string | null;
  result_meta: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface Idea {
  title: string;
  description: string;
  prompt: string;
}
