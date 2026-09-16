import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import { usesWindowsCredentialBroker } from "../../shared/platform";
import { Button } from "../../shared/ui/Button";

export function InstallationSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.getInstallationStatus>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = usesWindowsCredentialBroker();
  useEffect(() => {
    if (enabled) void api.getInstallationStatus().then(setStatus).catch((reason: unknown) => setError(resolveApiError(reason, t("errors.unknown"))));
  }, [enabled, t]);
  if (!enabled || (!status?.directory && !error)) return null;
  async function repair() {
    setBusy(true); setError(null);
    try { setStatus(await api.repairInstallationEntries()); }
    catch (reason) { setError(resolveApiError(reason, t("errors.unknown"))); }
    finally { setBusy(false); }
  }
  return <section className="settings-panel" aria-labelledby="installation-title">
    <header className="settings-panel-header"><h3 id="installation-title">{t("installation.title")}</h3></header>
    <p>{status?.directory}</p>
    <p>{t("installation.hint")}</p>
    {status?.issues.map((issue) => <p role="alert" key={issue}>{issue}</p>)}
    {status?.restartAgent ? <p>{t("installation.restartAgent")}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <Button disabled={busy} variant="ghost" onClick={() => void repair()}>{t("installation.repair")}</Button>
  </section>;
}
