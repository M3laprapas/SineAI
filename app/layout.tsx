import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import SessionRefresher from "@/components/SessionRefresher";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SineAI — Complementa tus pistas con IA",
  description:
    "Sube una pista instrumental y genera con IA pistas secundarias que la complementan, adaptadas a su BPM, tono y género.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#0b0d14] text-slate-200">
        <SessionRefresher />
        {children}
      </body>
    </html>
  );
}
