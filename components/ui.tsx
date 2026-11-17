'use client';
import type { ReactNode } from 'react';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-xl border border-black/10 bg-white dark:border-white/10 dark:bg-zinc-900/60', className)}>{children}</div>;
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent';

const TONE: Record<Tone, string> = {
  neutral: 'bg-black/5 text-black/70 dark:bg-white/10 dark:text-white/70',
  good: 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
  warn: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  bad: 'bg-red-600/10 text-red-700 dark:text-red-400',
  info: 'bg-sky-600/10 text-sky-700 dark:text-sky-300',
  accent: 'bg-indigo-600/10 text-indigo-700 dark:text-indigo-300',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', TONE[tone])}>
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  title,
  size = 'md',
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'good';
  disabled?: boolean;
  title?: string;
  size?: 'sm' | 'md';
  type?: 'button' | 'submit';
}) {
  const v = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-500',
    secondary: 'border border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10',
    ghost: 'hover:bg-black/5 dark:hover:bg-white/10 opacity-80 hover:opacity-100',
    danger: 'border border-red-500/30 text-red-600 hover:bg-red-500/10 dark:text-red-400',
    good: 'bg-emerald-600 text-white hover:bg-emerald-500',
  }[variant];
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-4 py-2 text-sm',
        v,
      )}
    >
      {children}
    </button>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="min-w-[8.5rem] rounded-lg border border-black/10 px-3 py-2 dark:border-white/10">
      <div className="text-[11px] font-medium uppercase tracking-wide opacity-60">{label}</div>
      <div
        className={cx(
          'mt-0.5 text-lg font-semibold tabular-nums',
          tone === 'good' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'warn' && 'text-amber-600 dark:text-amber-400',
          tone === 'bad' && 'text-red-600 dark:text-red-400',
        )}
      >
        {value}
      </div>
      {hint && <div className="text-xs opacity-60">{hint}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs opacity-60">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-md border border-black/15 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-white/20 dark:bg-zinc-900';

export function downloadBuffer(buf: ArrayBuffer, fileName: string) {
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
