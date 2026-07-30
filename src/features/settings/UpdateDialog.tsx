import { Download, RefreshCw, X } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../shared/ui/Button";
import { selectLocalizedReleaseNotes } from "./releaseNotes";
import type { AppUpdaterController } from "./useAppUpdater";

interface UpdateDialogProps {
  updater: AppUpdaterController;
}

// 更新弹窗很少出现，按需加载 Markdown 依赖，避免增加日常启动主包体积。
const ReleaseNotesMarkdown = lazy(() => import("./ReleaseNotesMarkdown"));

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
  const busy =
    updater.phase === "ignoring" ||
    updater.phase === "downloading" ||
    updater.phase === "installing";

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
      <section
        aria-labelledby="update-dialog-title"
        aria-modal="true"
        className="dialog update-dialog"
        role="dialog"
      >
        <header className="dialog-header">
          <div className="update-dialog-title">
            <Download aria-hidden="true" size={22} />
            <h2 id="update-dialog-title">{t("settings.updateAvailableTitle")}</h2>
          </div>
          <button
            aria-label={t("sessions.close")}
            className="icon-button update-dialog-close"
            disabled={busy}
            onClick={() => void updater.dismissUpdate()}
            type="button"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </header>
        <div className="update-dialog-body">
          <div className="update-version-summary">
            <span>v{updater.currentVersion ?? "—"}</span>
            <span aria-hidden="true">→</span>
            <strong>v{update.version}</strong>
            <span className="update-version-badge">{t("settings.newVersion")}</span>
          </div>
          {releaseDate ? (
            <div className="update-release-date">
              {t("settings.releaseDate")}: {releaseDate}
            </div>
          ) : null}
          <div className="update-release-notes">
            <h3>{t("settings.releaseNotes")}</h3>
            <Suspense
              fallback={
                <div className="update-release-markdown">
                  {releaseNotes || t("settings.noReleaseNotes")}
                </div>
              }
            >
              <ReleaseNotesMarkdown content={releaseNotes || t("settings.noReleaseNotes")} />
            </Suspense>
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
          {updater.phase === "ignoring" ? (
            <div className="loading-banner">{t("settings.ignoringUpdate")}</div>
          ) : null}
          {updater.phase === "completed" ? (
            <div className="form-success">{t("settings.updateInstalled")}</div>
          ) : null}
          {updater.ignoreError ? (
            <div className="form-error">{t("settings.ignoreUpdateFailed")}</div>
          ) : updater.phase === "error" ? (
            <div className="form-error">
              {updater.error || t("settings.updateUnknownError")}
            </div>
          ) : null}
        </div>
        <footer className="dialog-actions">
          {!busy && (updater.phase === "available" || updater.phase === "error") ? (
            <Button onClick={() => void updater.ignoreUpdate()} variant="ghost">
              {t("settings.ignoreUpdate")}
            </Button>
          ) : null}
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
