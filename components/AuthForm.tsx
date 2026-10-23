"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!email.trim() || !password) {
      setError("Introduce email y contraseña.");
      return;
    }
    setLoading(true);
    const supabase = createClient();
    try {
      if (mode === "signup") {
        const { data, error: signErr } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (signErr) {
          setError(friendlyAuthError(signErr.message));
          return;
        }
        if (data.session) {
          // Confirmación de email desactivada: entramos directamente
          router.push("/");
          router.refresh();
        } else {
          setNotice("Cuenta creada. Revisa tu email para confirmar el acceso.");
        }
      } else {
        const { error: signErr } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signErr) {
          setError(friendlyAuthError(signErr.message));
          return;
        }
        router.push("/");
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-[#111522]/90 p-6 shadow-xl shadow-black/40">
      <div className="mb-6 grid grid-cols-2 gap-1 rounded-lg bg-slate-900/70 p-1">
        {(["login", "signup"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError(null);
              setNotice(null);
            }}
            className={`rounded-md px-3 py-2 text-sm font-medium transition ${
              mode === m
                ? "bg-indigo-600 text-white shadow"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {m === "login" ? "Entrar" : "Crear cuenta"}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-400">
            Email
          </label>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="tu@email.com"
            className="w-full rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-400">
            Contraseña
          </label>
          <input
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
          />
        </div>

        {error && (
          <p className="rounded-lg border border-rose-900/60 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-lg border border-emerald-900/60 bg-emerald-950/50 px-3 py-2 text-xs text-emerald-300">
            {notice}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading
            ? "Un momento…"
            : mode === "login"
              ? "Entrar"
              : "Crear cuenta gratis"}
        </button>
      </form>

      <p className="mt-4 text-center text-[11px] text-slate-500">
        Sin tarjeta. Solo necesitas un email para empezar.
      </p>
    </div>
  );
}

function friendlyAuthError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("invalid login")) return "Email o contraseña incorrectos.";
  if (m.includes("already registered")) return "Ese email ya está registrado. Inicia sesión.";
  if (m.includes("password")) return "La contraseña debe tener al menos 6 caracteres.";
  if (m.includes("rate") || m.includes("too many")) return "Demasiados intentos. Espera un minuto.";
  return msg;
}
