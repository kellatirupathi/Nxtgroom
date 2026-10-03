import type { ReactNode } from 'react';

interface IconTooltipProps {
  label: string;
  children: ReactNode;
}

export default function IconTooltip({ label, children }: IconTooltipProps) {
  return (
    <span className="relative inline-flex group/tip">
      {children}
      <span
        role="presentation"
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] font-semibold text-white opacity-0 shadow-lg transition-opacity duration-75 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}
