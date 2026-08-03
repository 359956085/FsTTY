import { Download, Trash2, Upload } from "lucide-react";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type { CommandHistorySettings } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";

export function CommandHistorySettingsSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<CommandHistorySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function loadSettings() {
    setError(null);
    try {
      setSettings(await api.getCommandHistorySettings());
    } catch (nextError) {
      setError(resolveApiError(nextError, t("settings.commandHistoryLoadFailed")));
    }
  }

  useEffect(() => {
    void loadSettings();
    // 设置页首次挂载时读取独立历史库，语言变化不应重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function updateDeduplication(enabled: boolean) {
    if (!settings || busy || enabled === settings.deduplicate) return;
    if (enabled && settings.duplicateCount > 0) {
      try {
        const accepted = await confirm(
          t("settings.commandHistoryDedupeConfirm", { count: settings.duplicateCount }),
          {
            title: t("settings.commandHistoryDedupe"),
            kind: "warning",
            okLabel: t("settings.commandHistoryDedupeConfirmAction"),
            cancelLabel: t("sessions.cancel"),
          },
        );
        if (!accepted) return;
      } catch (nextError) {
        setError(resolveApiError(nextError, t("settings.commandHistorySaveFailed")));
        return;
      }
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const next = await api.updateCommandHistoryDeduplication(enabled);
      setSettings(next);
      setStatus(t("settings.commandHistorySettingsSaved"));
    } catch (nextError) {
      setError(resolveApiError(nextError, t("settings.commandHistorySaveFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function importHistory() {
    if (busy) return;
    try {
      const path = await open({
        directory: false,
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
        title: t("settings.commandHistoryImport"),
      });
      if (!path) return;
      setBusy(true);
      setError(null);
      setStatus(null);
      const result = await api.importCommandHistory(path);
      setSettings(await api.getCommandHistorySettings());
      setStatus(
        t("settings.commandHistoryImportSucceeded", {
          imported: result.importedCount,
          merged: result.mergedCount,
          total: result.totalCount,
        }),
      );
    } catch (nextError) {
      setError(resolveApiError(nextError, t("settings.commandHistoryImportFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function exportHistory() {
    if (busy) return;
    try {
      const path = await save({
        defaultPath: defaultExportName(),
        filters: [{ name: "JSON", extensions: ["json"] }],
        title: t("settings.commandHistoryExport"),
      });
      if (!path) return;
      setBusy(true);
      setError(null);
      setStatus(null);
      await api.exportCommandHistory(path);
      setStatus(t("settings.commandHistoryExportSucceeded"));
    } catch (nextError) {
      setError(resolveApiError(nextError, t("settings.commandHistoryExportFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function clearHistory() {
    if (!settings || settings.entryCount === 0 || busy) return;
    try {
      const accepted = await confirm(t("settings.commandHistoryClearConfirm"), {
        title: t("settings.commandHistoryClear"),
        kind: "warning",
        okLabel: t("settings.commandHistoryClearAction"),
        cancelLabel: t("sessions.cancel"),
      });
      if (!accepted) return;
      setBusy(true);
      setError(null);
      setStatus(null);
      setSettings(await api.clearCommandHistory());
      setStatus(t("settings.commandHistoryCleared"));
    } catch (nextError) {
      setError(resolveApiError(nextError, t("settings.commandHistoryClearFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="command-history-settings-title" className="settings-panel">
      <header className="settings-panel-header">
        <h3 id="command-history-settings-title">{t("settings.commandHistory")}</h3>
      </header>
      <div className="settings-row">
        <div className="settings-row-copy">
          <label className="settings-row-label" htmlFor="command-history-deduplicate">
            {t("settings.commandHistoryDedupe")}
          </label>
          <small>{t("settings.commandHistoryDedupeHint")}</small>
        </div>
        <input
          aria-label={t("settings.commandHistoryDedupe")}
          checked={settings?.deduplicate ?? false}
          className="settings-auto-update-toggle"
          disabled={!settings || busy}
          id="command-history-deduplicate"
          onChange={(event) => void updateDeduplication(event.target.checked)}
          role="switch"
          type="checkbox"
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-copy">
          <span className="settings-row-label">{t("settings.commandHistoryTransfer")}</span>
          <small>{t("settings.commandHistorySensitiveHint")}</small>
        </div>
        <div className="settings-history-actions">
          <Button
            disabled={busy}
            icon={<Upload aria-hidden="true" size={15} />}
            onClick={() => void importHistory()}
            variant="ghost"
          >
            {t("settings.commandHistoryImport")}
          </Button>
          <Button
            disabled={busy}
            icon={<Download aria-hidden="true" size={15} />}
            onClick={() => void exportHistory()}
            variant="ghost"
          >
            {t("settings.commandHistoryExport")}
          </Button>
        </div>
      </div>
      <div className="settings-row settings-history-row-last">
        <div className="settings-row-copy">
          <span className="settings-row-label">{t("settings.commandHistoryClear")}</span>
          <small>
            {t("settings.commandHistoryCount", { count: settings?.entryCount ?? 0 })}
          </small>
        </div>
        <Button
          disabled={!settings || settings.entryCount === 0 || busy}
          icon={<Trash2 aria-hidden="true" size={15} />}
          onClick={() => void clearHistory()}
          variant="danger"
        >
          {t("settings.commandHistoryClear")}
        </Button>
      </div>
      {error ? (
        <div className="form-error settings-error" role="alert">
          {error}
        </div>
      ) : null}
      {status ? (
        <div aria-live="polite" className="settings-success settings-history-status">
          {status}
        </div>
      ) : null}
    </section>
  );
}

function defaultExportName() {
  const now = new Date();
  const part = (value: number) => String(value).padStart(2, "0");
  return `fstty-command-history-${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}.json`;
}
