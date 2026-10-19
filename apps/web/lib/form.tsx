export function Field({ label, name, type = "text", autoComplete, required = true }: {
  label: string; name: string; type?: string; autoComplete?: string; required?: boolean;
}) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <input className="input mt-1 font-normal" name={name} type={type} autoComplete={autoComplete} required={required} />
    </label>
  );
}

export function ErrorNote({ message }: { message?: string }) {
  return message ? <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm">{message}</p> : null;
}

export function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="mb-6 text-2xl font-bold">{title}</h1>
      <div className="card space-y-4">{children}</div>
    </div>
  );
}
