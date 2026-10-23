import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Dashboard from "@/components/Dashboard";
import type { Track } from "@/lib/types";

// Página autenticada: se renderiza en cada petición (lee cookies de sesión).
export const instant = false;

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: tracks } = await supabase
    .from("tracks")
    .select("*")
    .order("created_at", { ascending: false });

  return (
    <Dashboard
      email={user.email ?? ""}
      initialTracks={(tracks ?? []) as Track[]}
    />
  );
}
