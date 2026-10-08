interface LocalTabStatusIconProps {
  administrator: boolean;
  running: boolean;
  description: string;
}

export function LocalTabStatusIcon({ administrator, running, description }: LocalTabStatusIconProps) {
  return (
    <span aria-hidden="true" title={description}
      className={`local-tab-status local-tab-status-${running ? "running" : "idle"}`}
      data-permission={administrator ? "administrator" : "standard"}>
      <svg width="16" height="16" viewBox="0 0 16 16" focusable="false">
        {administrator ? (
          <g fill={running ? "currentColor" : "none"} stroke={running ? "none" : "currentColor"} strokeWidth="1.5">
            <circle cx="8" cy="4" r="2.75" />
            <path d="M2 15v-1a6 6 0 0 1 12 0v1Z" />
          </g>
        ) : <circle cx="8" cy="8" r="4.5" fill="currentColor" />}
      </svg>
    </span>
  );
}
