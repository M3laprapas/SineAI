import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import TrackWorkspace from "@/components/TrackWorkspace";
import type { Generation, Track } from "@/lib/types";

// Página autenticada: se renderiza en cada petición (lee cookies de sesión).
export const instant = false;

export default async function TrackPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: track } = await supabase
    .from("tracks")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!track) notFound();

  const { data: gens } = await supabase
    .from("generations")
    .select("*")
    .eq("track_id", id)
    .order("created_at", { ascending: false });

  return (
    <TrackWorkspace
      track={track as Track}
      initialGenerations={(gens ?? []) as Generation[]}
    />
  );
}
