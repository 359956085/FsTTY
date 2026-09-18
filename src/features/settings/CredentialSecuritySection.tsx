import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../shared/ui/Button";
import { usesWindowsCredentialBroker } from "../../shared/platform";
import { CredentialSecurityDialog } from "./CredentialSecurityDialog";

export function CredentialSecuritySection() {
  const { t } = useTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const enabled = usesWindowsCredentialBroker();
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  if (!enabled) return null;

  return (
    <section aria-labelledby="credential-management-title" className="settings-panel">
      <header className="settings-panel-header">
        <h3 id="credential-management-title">{t("security.managementTitle")}</h3>
      </header>
      <div className="settings-row settings-credential-management-row">
        <span className="settings-row-label" title={t("security.title")}>
          {t("security.title")}
        </span>
        <Button
          aria-haspopup="dialog"
          onClick={(event) => {
            event.currentTarget.focus();
            setDialogOpen(true);
          }}
          variant="ghost"
        >
          {t("security.manage")}
        </Button>
      </div>
      {dialogOpen ? <CredentialSecurityDialog onClose={closeDialog} /> : null}
    </section>
  );
}
