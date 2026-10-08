import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LocalSession, LocalSessionPayload, LocalShell } from "../../shared/api/types";
import { resolveApiError } from "../../shared/api/errors";
import { Button } from "../../shared/ui/Button";
import { TextInput } from "../../shared/ui/TextInput";
import { useDialogFocus } from "../../shared/ui/useDialogFocus";
import { LOCAL_SHELL_LABELS } from "./localSession";
import { SessionGroupField } from "./SessionGroupField";
import { isComposingKey, isFocusAvailable } from "../../shared/ui/focus";
import { DEFAULT_SESSION_GROUP } from "./constants";

interface Props {
  shell: LocalShell;
  session?: LocalSession;
  groupOptions: string[];
  onSave: (payload: LocalSessionPayload) => Promise<void>;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
  fallbackFocus: () => HTMLElement | null;
}
export function LocalSessionFormDialog({
  shell, session, groupOptions, onSave, onClose, returnFocus, fallbackFocus,
}: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState(session?.name ?? LOCAL_SHELL_LABELS[shell]);
  const [group, setGroup] = useState(session?.group === DEFAULT_SESSION_GROUP ? "" : session?.group ?? "");
  const [directory, setDirectory] = useState(session?.startingDirectory ?? "");
  const [admin, setAdmin] = useState(session?.runAsAdmin ?? false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const browseButton = useRef<HTMLButtonElement>(null);
  const restoreBrowseFocus = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const { dialogRef, requestClose } = useDialogFocus({
    onClose: () => { if (!busyRef.current) onClose(); },
    canClose: !busy,
    initialFocus: (node) => node.querySelector("input"),
    returnFocus,
    fallbackFocus,
  });

  useLayoutEffect(() => {
    if (busy || !restoreBrowseFocus.current) return;
    restoreBrowseFocus.current = false;
    const button = browseButton.current;
    const dialog = button?.closest('[role="dialog"]');
    const active = document.activeElement;
    const activeDialog = active?.closest('[role="dialog"][aria-modal="true"]');
    // The picker owns this handoff; never take focus from another dialog or control outside this form.
    if (isFocusAvailable(button) && dialog && (!activeDialog || activeDialog === dialog) &&
      (active === document.body || (active && dialog.contains(active)))) button.focus({ preventScroll: true });
  }, [busy]);

  async function perform(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      if (mounted.current) setError(resolveApiError(error, t("errors.unknown")));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function browseDirectory() {
    try {
      const result = await open({ directory: true, multiple: false });
      if (result && mounted.current) setDirectory(result);
    } finally {
      if (mounted.current) restoreBrowseFocus.current = true;
    }
  }

  return (
    <div className="dialog-backdrop">
      <form
        className="dialog session-dialog local-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === "Enter" && isComposingKey(event.nativeEvent)) event.preventDefault();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void perform(() => onSave({
            id: session?.id, name, group, shell,
            startingDirectory: directory,
            runAsAdmin: admin,
          }));
        }}
      >
        <header className="dialog-header">
          <h2 id={id}>{t(session ? "sessions.edit" : "sessions.new")} {LOCAL_SHELL_LABELS[shell]}</h2>
          <button type="button" className="icon-button" aria-label={t("sessions.close")}
            disabled={busy} onClick={requestClose}><X size={18} aria-hidden="true" /></button>
        </header>
        <div className="form-grid local-session-fields">
          <label>
            <span>{t("sessions.name")}</span>
            <TextInput required maxLength={128} value={name} readOnly={busy}
              onChange={(event) => setName(event.target.value)} />
          </label>
          <SessionGroupField value={group} onChange={setGroup} options={groupOptions} disabled={busy} />
          <div className="form-field local-directory-field">
            <label htmlFor={`${id}-directory`}>{t("local.startingDirectory")}</label>
            <div className="local-directory-control">
              <TextInput id={`${id}-directory`} value={directory} readOnly={busy} placeholder={t("local.homeDirectory")}
                onChange={(event) => setDirectory(event.target.value)} />
              <button type="button" className="local-directory-button" ref={browseButton} disabled={busy}
                aria-label={t("local.browseDirectory")} onClick={() => void perform(browseDirectory)}>
                <FolderOpen size={18} aria-hidden="true" />
              </button>
            </div>
          </div>
          <label className="local-admin-option">
            <input type="checkbox" checked={admin} disabled={busy}
              onChange={(event) => setAdmin(event.target.checked)} />
            {t("local.defaultAdmin")}
          </label>
          {error && <div role="alert" className="form-error">{error}</div>}
        </div>
        <footer className="dialog-actions">
          <Button variant="ghost" disabled={busy} onClick={requestClose}>{t("sessions.cancel")}</Button>
          <Button type="submit" disabled={busy}>{t("sessions.save")}</Button>
        </footer>
      </form>
    </div>
  );
}
