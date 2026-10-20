export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <p className="text-sm font-medium uppercase tracking-wide text-emerald-700">
        Stage 1 placeholder
      </p>
      <h1 className="text-3xl font-semibold">Storefront coming soon</h1>
      <p className="text-stone-600">
        This page confirms the web app is running. It shows no products, prices, stock or checkout.
        Those arrive in Stages 3 and 6.
      </p>
      <p className="text-sm text-stone-500">
        Health check: <a className="underline" href="/api/health">/api/health</a>
      </p>
    </main>
  );
}
