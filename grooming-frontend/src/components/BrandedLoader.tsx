export default function BrandedLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <main className="min-h-[100svh] flex flex-col items-center justify-center bg-[#f8f9fc] p-6">
      <div className="flex flex-col items-center">
        <div className="relative flex h-24 w-24 items-center justify-center" aria-hidden="true">
          <span className="absolute inset-0 rounded-full bg-indigo-500/10 animate-ping loader-ring" />
          <span
            className="absolute inset-2 rounded-full bg-indigo-500/10 animate-ping loader-ring"
            style={{ animationDelay: '400ms' }}
          />
          <img
            src="/logo.png"
            alt=""
            className="relative h-14 w-14 object-contain drop-shadow-sm animate-pulse loader-mark"
          />
        </div>

        <h1 className="mt-5 text-xl font-extrabold tracking-tight text-slate-800">FacultyTrack</h1>
        <div className="mt-6 h-1 w-40 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full w-1/3 rounded-full bg-indigo-500 loader-sweep" />
        </div>

        <p className="sr-only" role="status">
          {label}
        </p>
      </div>
    </main>
  );
}
