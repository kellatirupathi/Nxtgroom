import { useEffect, useRef, useState } from 'react';
import { MoreVertical, Pencil, KeyRound, Trash2 } from 'lucide-react';

export interface RowAction {
  key: string;
  label: string;
  icon: 'edit' | 'password' | 'delete';
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

const ICONS = { edit: Pencil, password: KeyRound, delete: Trash2 } as const;

interface RowActionsMenuProps {
  label: string;
  actions: RowAction[];
}

/**
 * Overflow menu for a table row. Rendered as a fixed-position popover so it is
 * never clipped by the table's own overflow-x container.
 */
export default function RowActionsMenu({ label, actions }: RowActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // Any scroll or resize invalidates the anchored coordinates.
    const reposition = () => setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const menuWidth = 208;
      const menuHeight = actions.length * 44 + 8;
      // Flip above / clamp within the viewport so the menu is never cut off.
      const top = rect.bottom + menuHeight > window.innerHeight
        ? Math.max(8, rect.top - menuHeight - 4)
        : rect.bottom + 4;
      const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
      setPosition({ top, left });
    }
    setOpen(true);
  };

  return (
    <div ref={rootRef} className="inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${label}`}
        className="rounded-md border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <MoreVertical size={16} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`Actions for ${label}`}
          style={{ top: position.top, left: position.left }}
          className="fixed z-50 w-52 rounded-md border border-slate-200 bg-white py-1 shadow-xl"
        >
          {actions.map((action) => {
            const Icon = ICONS[action.icon];
            return (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                disabled={action.disabled}
                onClick={() => {
                  setOpen(false);
                  action.onSelect();
                }}
                className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  action.destructive
                    ? 'text-rose-600 hover:bg-rose-50'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Icon size={15} aria-hidden="true" />
                {action.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
