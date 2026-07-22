import { Download, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../shared/ui/Button";
import { selectLocalizedReleaseNotes } from "./releaseNotes";
import type { AppUpdaterController } from "./useAppUpdater";

interface UpdateDialogProps {
  updater: AppUpdaterController;
}

function formatReleaseDate(value: string, locale: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

export function UpdateDialog({ updater }: UpdateDialogProps) {
  const { i18n, t } = useTranslation();
  const { dialogOpen, dismissUpdate } = updater;
  const update = updater.availableUpdate;
  const busy = updater.phase === "downloading" || updater.phase === "installing";

  useEffect(() => {
    if (!dialogOpen || busy) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        void dismissUpdate();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, dialogOpen, dismissUpdate]);

  if (!updater.dialogOpen || !update) {
    return null;
  }

  const progress = updater.totalBytes
    ? Math.min(100, Math.round((updater.downloadedBytes / updater.totalBytes) * 100))
    : null;
  const releaseDate = update.date
    ? formatReleaseDate(update.date, i18n.language)
    : null;
  const releaseNotes = selectLocalizedReleaseNotes(
    update.body,
    i18n.resolvedLanguage ?? i18n.language,
  );

  return (
    <div className="dialog-backdrop update-dialog-backdrop">
      <section aria-modal="true" className="dialog update-dialog" role="dialog">
        <header className="dialog-header">
          <Download aria-hidden="true" size={20} />
          <h2>{t("settings.updateAvailableTitle")}</h2>
        </header>
        <div className="update-dialog-body">
          <div className="update-version-summary">
            <span>v{updater.currentVersion ?? "—"}</span>
            <span aria-hidden="true">→</span>
            <strong>v{update.version}</strong>
          </div>
          {releaseDate ? (
            <div className="update-release-date">
              {t("settings.releaseDate")}: {releaseDate}
            </div>
          ) : null}
          <div className="update-release-notes">
            <h3>{t("settings.releaseNotes")}</h3>
            <div>{releaseNotes || t("settings.noReleaseNotes")}</div>
          </div>
          {updater.phase === "downloading" || updater.phase === "installing" ? (
            <div aria-live="polite" className="update-progress">
              <div className="update-progress-label">
                <span>
                  {updater.phase === "installing"
                    ? t("settings.installingUpdate")
                    : t("settings.downloadingUpdate")}
                </span>
                {progress !== null && updater.phase === "downloading" ? (
                  <span>{progress}%</span>
                ) : null}
              </div>
              <div
                aria-label={t("settings.updateProgress")}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={progress ?? undefined}
                className={
                  progress === null || updater.phase === "installing"
                    ? "update-progress-track update-progress-indeterminate"
                    : "update-progress-track"
                }
                role="progressbar"
              >
                <span style={progress === null ? undefined : { width: `${progress}%` }} />
              </div>
            </div>
          ) : null}
          {updater.phase === "completed" ? (
            <div className="form-success">{t("settings.updateInstalled")}</div>
          ) : null}
          {updater.phase === "error" ? (
            <div className="form-error">
              {updater.error || t("settings.updateUnknownError")}
            </div>
          ) : null}
        </div>
        <footer className="dialog-actions">
          {!busy ? (
            <Button onClick={() => void updater.dismissUpdate()} variant="ghost">
              {updater.phase === "completed" ? t("sessions.close") : t("sessions.cancel")}
            </Button>
          ) : null}
          {updater.phase === "available" || updater.phase === "error" ? (
            <Button
              className="update-action-button"
              icon={<RefreshCw aria-hidden="true" size={18} />}
              onClick={() => void updater.installUpdate()}
            >
              {updater.phase === "error" ? t("settings.retryUpdate") : t("settings.updateNow")}
            </Button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
