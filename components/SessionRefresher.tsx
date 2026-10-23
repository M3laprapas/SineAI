"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Nota: el proyecto NO usa proxy.ts porque el runtime de Netlify no puede
// empaquetarlo todavía (bug abierto opennextjs/opennextjs-netlify#3562 y
// #3575: falla al bundlear Node middleware de Next 16 como edge function).
// En su lugar, este puente renueva la sesión desde el navegador en cada
// navegación: si el access token caducó, supabase-js lo refresca y guarda
// las cookies nuevas, de modo que el servidor siempre encuentra vigencia.
// El "portero" de autenticación vive en las páginas (redirect a /login).
export default function SessionRefresher() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (cancelled) return;
        if (!user && pathname !== "/login") {
          router.replace("/login");
        }
      } catch {
        // errores de red: dejamos la página como está
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  return null;
}
