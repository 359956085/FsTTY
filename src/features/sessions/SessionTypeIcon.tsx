import type { LocalShell } from "../../shared/api/types";

/** Decorative session identity shared by the picker and saved session rows. */
export function SessionTypeIcon({ type }: { type: LocalShell | "ssh" }) {
  return (
    <svg className={`session-type-icon session-type-icon-${type}`} data-session-type={type}
      width="32" height="32" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="currentColor" />
      {type === "ssh" ? (
        <g fill="none" stroke="white" strokeWidth="1.5">
          {[7, 14, 21].map((y) => <g key={y}>
            <rect x="7" y={y} width="18" height="4" rx="1" />
            <path d={`M10 ${y + 2}h1M21 ${y + 2}h1`} />
          </g>)}
        </g>
      ) : type === "gitBash" ? (
        <g fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="m16 6 10 10-10 10L6 16Z M12 10l8 8 M16 14v9" />
          <circle cx="12" cy="10" r="1.4" fill="white" />
          <circle cx="16" cy="14" r="1.4" fill="white" />
          <circle cx="20" cy="18" r="1.4" fill="white" />
        </g>
      ) : type === "powershell" ? (
        <g fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m13 9 6 7-9 7 M19 22h5" />
        </g>
      ) : (
        <g fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m8 11 5 5-5 5 M17 21h7" />
        </g>
      )}
    </svg>
  );
}
