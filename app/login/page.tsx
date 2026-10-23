import AuthForm from "@/components/AuthForm";

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-white">
            Sine<span className="text-indigo-400">AI</span>
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            Sube tu pista instrumental y genera pistas secundarias que la
            complementen — adaptadas a su BPM, tono y género.
          </p>
        </div>
        <AuthForm />
      </div>
    </main>
  );
}
