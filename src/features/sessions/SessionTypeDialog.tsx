import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import type { LocalShell, LocalShellAvailability } from "../../shared/api/types";
import { resolveApiError } from "../../shared/api/errors";
import { useDialogFocus } from "../../shared/ui/useDialogFocus";
import { Button } from "../../shared/ui/Button";
import { isComposingKey } from "../../shared/ui/focus";
import { LOCAL_SHELL_LABELS } from "./localSession";
import { SessionTypeIcon } from "./SessionTypeIcon";

interface Props {
  onSelect: (shell: LocalShell | "ssh") => void;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
  fallbackFocus: () => HTMLElement | null;
}
export function SessionTypeDialog({ onSelect, onClose, returnFocus, fallbackFocus }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const translate = useRef(t);
  translate.current = t;
  const [revision, setRevision] = useState(0);
  const [shells, setShells] = useState<LocalShellAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { dialogRef, requestClose } = useDialogFocus({ onClose, returnFocus, fallbackFocus,
    initialFocus: (node) => node.querySelector(".session-type-option"),
  });
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void api.detectLocalShells().then((result) => { if (current) setShells(result); })
      .catch((error) => { if (current) setError(resolveApiError(error, translate.current("errors.unknown"))); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);
  return <div className="dialog-backdrop"><section className="dialog session-dialog session-type-dialog" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={dialogRef}
    onKeyDown={(event) => {
      if (isComposingKey(event.nativeEvent) && (event.key === "Enter" || event.key === " ")) event.preventDefault();
    }}>
    <header className="dialog-header"><h2 id={id}>{t("sessions.new")}</h2>
      <button type="button" className="icon-button" aria-label={t("sessions.close")} onClick={requestClose}><X size={18} aria-hidden="true" /></button>
    </header>
    <div className="dialog-body session-type-options">
      <button type="button" className="session-type-option" onClick={() => onSelect("ssh")}>
        <SessionTypeIcon type="ssh" /><span className="session-type-name">SSH</span>
      </button>
      {(Object.keys(LOCAL_SHELL_LABELS) as LocalShell[]).map((shell) => {
        const status = shells.find((item) => item.shell === shell);
        return <button type="button" className="session-type-option" key={shell}
          aria-label={LOCAL_SHELL_LABELS[shell]} aria-describedby={`${id}-${shell}`}
          disabled={loading || !status?.available} onClick={() => onSelect(shell)}>
          <SessionTypeIcon type={shell} /><span className="session-type-name">{LOCAL_SHELL_LABELS[shell]}</span>
          <span className="session-type-status" id={`${id}-${shell}`}>{loading ? t("common.loading") : status?.available ? status.label : status?.reason ?? t("local.notDetected")}</span>
        </button>;
      })}
      {error && <div role="alert" className="form-error">{error}</div>}
    </div>
    <footer className="dialog-actions"><Button variant="ghost" disabled={loading} onClick={() => setRevision((value) => value + 1)}>{t("local.detectAgain")}</Button><Button onClick={requestClose}>{t("sessions.cancel")}</Button></footer>
  </section></div>;
}
