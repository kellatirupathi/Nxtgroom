import { useId, useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * A password field with a reveal toggle.
 *
 * Typing a password blind is error-prone everywhere and worse on a phone
 * keyboard, where a mistyped character is invisible and the only feedback is a
 * failed sign-in. The toggle is a button rather than a checkbox so it does not
 * take part in form submission, and it is excluded from the tab order: someone
 * tabbing from the field expects to reach the submit button, not a control
 * that would expose their password.
 */
export default function PasswordInput({ className = '', ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const describedBy = useId();

  return (
    <div className="relative">
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        // Right padding keeps the text clear of the button.
        className={`${className} pr-11`}
        aria-describedby={describedBy}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </button>
      <span id={describedBy} className="sr-only">
        {visible ? 'Password is visible' : 'Password is hidden'}
      </span>
    </div>
  );
}
