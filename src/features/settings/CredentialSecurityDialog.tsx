import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type { Session } from "../../shared/api/types";
import { usesWindowsCredentialBroker } from "../../shared/platform";
import { Button } from "../../shared/ui/Button";

interface CredentialSecurityDialogProps {
  onClose: () => void;
}

export function CredentialSecurityDialog({ onClose }: CredentialSecurityDialogProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{ available: boolean; message: string | null } | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const enabled = usesWindowsCredentialBroker();

  const refresh = useCallback(async () => {
    setStatus(null);
    setSessions([]);
    const next = await api.getCredentialServiceStatus();
    if (!mountedRef.current) return;
    setStatus(next);
    if (next.available) {
      const groups = await api.listSessions();
      if (mountedRef.current) setSessions(groups.flatMap((group) => group.sessions));
    }
  }, []);

  const runOperation = useCallback(async (operation?: () => Promise<unknown>) => {
    // 同步锁同时覆盖首次加载、刷新和写入，避免快速点击及 StrictMode 重放重复提交。
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (operation) await operation();
      if (mountedRef.current) await refresh();
    } catch (reason) {
      if (mountedRef.current) setError(resolveApiError(reason, t("errors.unknown")));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [refresh, t]);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) void runOperation();
    return () => { mountedRef.current = false; };
  }, [enabled, runOperation]);

  const close = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    if (!enabled) return;
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "Tab" && dialog) {
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("*"))
          .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled"));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) {
          event.preventDefault();
          dialog.focus();
        } else if (!dialog.contains(document.activeElement) || document.activeElement === dialog) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [close, enabled]);

  if (!enabled) return null;
  const migrationIds = sessions
    .filter((session) => session.credentialState !== "stored")
    .slice(0, 32)
    .map((session) => session.id);

  return createPortal(
    <div
      className="dialog-backdrop settings-credential-security-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) close();
      }}
    >
      <section
        aria-busy={busy}
        aria-labelledby="credential-security-dialog-title"
        aria-modal="true"
        className="dialog settings-credential-security-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="dialog-header">
          <h2 id="credential-security-dialog-title">{t("security.title")}</h2>
          <button
            aria-label={t("sessions.close")}
            className="icon-button"
            disabled={busy}
            onClick={close}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="settings-credential-security-body">
          <p className="settings-credential-security-hint">{t("security.boundary")}</p>
          <div className="settings-row settings-credential-status-row">
            <span role="status">
              {t(status
                ? status.available ? "security.available" : "security.unavailable"
                : busy ? "security.checking" : "security.statusUnknown")}
            </span>
            <Button disabled={busy} onClick={() => void runOperation()} variant="ghost">
              {t("security.refresh")}
            </Button>
          </div>
          {status?.message ? <div className="form-error" role="alert">{status.message}</div> : null}
          {status && !status.available ? (
            <>
              <p className="settings-credential-security-hint">{t("security.repairHint")}</p>
              <div className="settings-credential-security-actions">
                <Button disabled={busy} onClick={() => void runOperation(() => api.repairCredentialService())}>
                  {t("security.repair")}
                </Button>
              </div>
            </>
          ) : null}
          {status?.available && migrationIds.length > 0 ? (
            <div className="settings-credential-security-actions">
              <Button disabled={busy} onClick={() => void runOperation(() => api.migrateSshCredentials(migrationIds))}>
                {t("security.migrateBatch")}
              </Button>
            </div>
          ) : null}
          {status?.available && sessions.length > 0 ? (
            <div aria-label={t("security.title")} className="settings-credential-security-list" role="list" tabIndex={0}>
              {sessions.map((session) => (
                <div className="settings-row" key={session.id} role="listitem">
                  <div className="settings-credential-security-copy">
                    <span>{session.name}</span>
                    <small>{t(`security.states.${session.credentialState}`)}</small>
                  </div>
                  {session.credentialState !== "stored" ? (
                    <Button disabled={busy} onClick={() => void runOperation(() => api.migrateSshCredential(session.id))}>
                      {t("security.migrate")}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {status?.available && sessions.length === 0 && !error ? (
            <p className="settings-credential-security-empty">
              {t(busy ? "common.loading" : "security.empty")}
            </p>
          ) : null}
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          <p className="settings-credential-security-hint">{t("security.originalsHint")}</p>
        </div>
        <footer className="dialog-actions">
          <Button disabled={busy} onClick={close} variant="ghost">
            {t("sessions.close")}
          </Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
