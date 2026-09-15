import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type { Session } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { usesWindowsCredentialBroker } from "../../shared/platform";

export function CredentialSecuritySection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{ available: boolean; message: string | null } | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = usesWindowsCredentialBroker();
  const refresh = useCallback(async () => {
    const next = await api.getCredentialServiceStatus();
    setStatus(next);
    setSessions(next.available ? (await api.listSessions()).flatMap((group) => group.sessions) : []);
  }, []);
  useEffect(() => {
    if (enabled) void refresh().catch((reason: unknown) => setError(resolveApiError(reason, t("errors.unknown"))));
  }, [enabled, refresh, t]);
  if (!enabled) return null;
  async function migrate(id: string) {
    setBusy(true); setError(null);
    try { await api.migrateSshCredential(id); await refresh(); }
    catch (reason) { setError(resolveApiError(reason, t("errors.unknown"))); }
    finally { setBusy(false); }
  }
  async function repair() {
    setBusy(true); setError(null);
    try { await api.repairCredentialService(); await refresh(); }
    catch (reason) { setError(resolveApiError(reason, t("errors.unknown"))); }
    finally { setBusy(false); }
  }
  async function migrateBatch() {
    setBusy(true); setError(null);
    try {
      await api.migrateSshCredentials(sessions.filter((session) => session.credentialState !== "stored").slice(0, 32).map((session) => session.id));
      await refresh();
    } catch (reason) { setError(resolveApiError(reason, t("errors.unknown"))); }
    finally { setBusy(false); }
  }
  return <section className="settings-panel" aria-labelledby="credential-security-title">
    <header className="settings-panel-header"><h3 id="credential-security-title">{t("security.title")}</h3></header>
    <p>{t("security.boundary")}</p>
    <div className="settings-row">
      <span>{status ? t(status.available ? "security.available" : "security.unavailable") : t("security.checking")}</span>
      <Button disabled={busy} variant="ghost" onClick={() => void refresh().catch((reason: unknown) => setError(resolveApiError(reason, t("errors.unknown"))))}>{t("security.refresh")}</Button>
    </div>
    {status?.message ? <p role="alert">{status.message}</p> : null}
    {status && !status.available ? <p>{t("security.repairHint")}</p> : null}
    {status && !status.available ? <Button disabled={busy} onClick={() => void repair()}>{t("security.repair")}</Button> : null}
    {status?.available && sessions.some((session) => session.credentialState !== "stored") ? <Button disabled={busy} onClick={() => void migrateBatch()}>{t("security.migrateBatch")}</Button> : null}
    {sessions.map((session) => <div className="settings-row" key={session.id}>
      <span>{session.name} — {t(`security.states.${session.credentialState}`)}</span>
      {session.credentialState !== "stored" ? <Button disabled={busy} onClick={() => void migrate(session.id)}>{t("security.migrate")}</Button> : null}
    </div>)}
    <p>{t("security.originalsHint")}</p>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
