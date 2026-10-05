import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LocalSession, LocalSessionPayload, LocalShell } from "../../shared/api/types";
import { resolveApiError } from "../../shared/api/errors";
import { Button } from "../../shared/ui/Button";
import { TextInput } from "../../shared/ui/TextInput";
import { useDialogFocus } from "../../shared/ui/useDialogFocus";
import { LOCAL_SHELL_LABELS } from "./localSession";
import { SessionGroupField } from "./SessionGroupField";
import { isComposingKey } from "../../shared/ui/focus";
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
    const result = await open({ directory: true, multiple: false });
    if (result && mounted.current) setDirectory(result);
  }

  return (
    <div className="dialog-backdrop">
      <form
        className="dialog session-form"
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
        </header>
        <div className="form-grid local-session-fields">
          <label>
            <span>{t("sessions.name")}</span>
            <TextInput required maxLength={128} value={name} readOnly={busy}
              onChange={(event) => setName(event.target.value)} />
          </label>
          <SessionGroupField value={group} onChange={setGroup} options={groupOptions} disabled={busy} />
          <label>
            <span>{t("local.startingDirectory")}</span>
            <TextInput value={directory} readOnly={busy} placeholder={t("local.homeDirectory")}
              onChange={(event) => setDirectory(event.target.value)} />
          </label>
          <Button disabled={busy} onClick={() => void perform(browseDirectory)}>
            {t("local.browseDirectory")}
          </Button>
          <label className="local-admin-option">
            <input type="checkbox" checked={admin} disabled={busy}
              onChange={(event) => setAdmin(event.target.checked)} />
            {t("local.defaultAdmin")}
          </label>
          {error && <div role="alert" className="form-error">{error}</div>}
        </div>
        <footer className="dialog-actions">
          <Button disabled={busy} onClick={requestClose}>{t("sessions.cancel")}</Button>
          <Button type="submit" disabled={busy}>{t("sessions.save")}</Button>
        </footer>
      </form>
    </div>
  );
}
