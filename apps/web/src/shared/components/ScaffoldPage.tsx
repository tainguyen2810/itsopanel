import type { ReactNode } from 'react';

interface Props {
  title: string;
  subtitle: string;
  children: ReactNode;
}

/** Khung trang tạm của Prompt 1.5 (chưa có UI thật). */
export function ScaffoldPage({ title, subtitle, children }: Props) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-4 py-10">
      <header>
        <p className="text-sm text-muted">ITSO Panel · scaffold Prompt 1.5</p>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-muted">{subtitle}</p>
      </header>
      <section className="rounded-xl border border-line bg-card px-5 py-3">
        <ul className="divide-y divide-line">{children}</ul>
      </section>
    </main>
  );
}
