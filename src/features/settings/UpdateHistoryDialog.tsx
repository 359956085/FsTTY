import { History, X } from "lucide-react";
import { useMemo, type RefCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import changelog from "../../../CHANGELOG.md?raw";
import { Button } from "../../shared/ui/Button";
import ReleaseNotesMarkdown from "./ReleaseNotesMarkdown";
import { parseUpdateHistory } from "./updateHistory";

interface UpdateHistoryDialogProps {
  onClose: () => void;
  open: boolean;
  dialogRef: RefCallback<HTMLElement>;
}

export function UpdateHistoryDialog({ onClose, open, dialogRef }: UpdateHistoryDialogProps) {
  const { i18n, t } = useTranslation();
  const entries = useMemo(
    () => parseUpdateHistory(changelog, i18n.resolvedLanguage ?? i18n.language),
    [i18n.language, i18n.resolvedLanguage],
  );

  return open
    ? createPortal(
        <div
          className="dialog-backdrop update-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) {
              // Keep the mouse's default focus change from undoing restoration.
              event.preventDefault();
              onClose();
            }
          }}
        >
          <section
            aria-labelledby="update-history-dialog-title"
            aria-modal="true"
            className="dialog update-dialog update-history-dialog"
            role="dialog"
            ref={dialogRef}
            tabIndex={-1}
          >
            <header className="dialog-header">
              <div className="update-dialog-title">
                <History aria-hidden="true" size={22} />
                <h2 id="update-history-dialog-title">{t("settings.updateHistory")}</h2>
              </div>
              <button
                aria-label={t("sessions.close")}
                className="icon-button update-dialog-close"
                onClick={onClose}
                type="button"
              >
                <X aria-hidden="true" size={20} />
              </button>
            </header>
            <div aria-label={t("settings.updateHistory")} className="update-dialog-body update-history-list" role="region" tabIndex={0}>
              {entries.map((entry) => (
                <article className="update-history-entry" key={entry.version}>
                  <header>
                    <h3>v{entry.version}</h3>
                    <time dateTime={entry.date}>{entry.date}</time>
                  </header>
                  <ReleaseNotesMarkdown content={entry.notes} />
                </article>
              ))}
            </div>
            <footer className="dialog-actions">
              <Button onClick={onClose} variant="ghost">
                {t("sessions.close")}
              </Button>
            </footer>
          </section>
        </div>,
        document.body,
      )
    : null;
}
