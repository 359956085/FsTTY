import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { api } from "../../shared/api/client";
import type { FileEntry, PermissionChange, PermissionPatch, RemotePermissionEntry } from "../../shared/api/types";
import { resolveApiError } from "../../shared/api/errors";
import { useDialogFocus } from "../../shared/ui/useDialogFocus";
const emptyPatch = (): PermissionPatch => ({ mask: 0, value: 0 });
interface GridProps {
  label: string;
  entries: RemotePermissionEntry[];
  patch: PermissionPatch;
  onChange: (p: PermissionPatch) => void;
  disabled: boolean;
  onValid: (valid: boolean) => void;
}
function PermissionGrid({ label, entries, patch, onChange, disabled, onValid }: GridProps) {
  const { t } = useTranslation();
  const [octal, setOctal] = useState("");
  const [invalid, setInvalid] = useState(false);
  const modes = entries.flatMap(e => e.mode === null ? [] : [e.mode & 0o777]);
  function current(bit: number): boolean | null {
    if (patch.mask & bit) return Boolean(patch.value & bit);
    if (!modes.length) return null;
    const value = Boolean(modes[0] & bit);
    return modes.every(mode => Boolean(mode & bit) === value) ? value : null;
  }
  const bits = [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 4, 2, 1];
  const common = bits.every(bit => current(bit) !== null) ? bits.reduce((value, bit) => current(bit) ? value | bit : value, 0).toString(8).padStart(3, "0") : null;
  return <fieldset className="permission-grid" disabled={disabled}><legend>{label}</legend><table><thead><tr><th></th>{["read", "write", "execute"].map(key => <th key={key}>{t("fileManagement." + key)}</th>)}</tr></thead><tbody>
  {["owner", "group", "others"].map((group, row) => <tr key={group}><th>{t("fileManagement." + group)}</th>{[4, 2, 1].map(value => { const bit = value << (6 - row * 3); const checked = current(bit); return <td key={bit}><input type="checkbox" aria-label={label + " " + t("fileManagement." + group) + " " + t("fileManagement." + ({ 4: "read", 2: "write", 1: "execute" }[value]))} aria-checked={checked === null ? "mixed" : checked} checked={checked === true} ref={node => { if (node)
    node.indeterminate = checked === null; }} onChange={e => { setOctal(""); setInvalid(false); onValid(true); onChange({ mask: patch.mask | bit, value: e.target.checked ? patch.value | bit : patch.value & ~bit }); }}/></td>; })}</tr>)}
 </tbody></table><label className="permission-octal">{t("fileManagement.octal")}<input inputMode="numeric" maxLength={3} aria-label={label + " " + t("fileManagement.octal")} value={octal} placeholder={common ?? t("fileManagement.unchanged")} aria-invalid={invalid} onChange={e => { const text = e.target.value; setOctal(text); const valid = text === "" || /^[0-7]{3}$/.test(text); setInvalid(!valid); onValid(valid); if (!text)
    onChange(emptyPatch());
  else if (valid)
    onChange({ mask: 0o777, value: parseInt(text, 8) }); }}/></label>
 {invalid && <small role="alert">{t("fileManagement.invalidMode")}</small>}<button type="button" onClick={() => { setOctal(""); setInvalid(false); onValid(true); onChange(emptyPatch()); }}>{t("fileManagement.keepUnchanged")}</button></fieldset>;
}
interface Props {
  connectionId: string;
  files: FileEntry[];
  onClose: () => void;
  onApply: (request: PermissionChange) => Promise<void>;
  returnFocus?: () => HTMLElement | null;
}
export function PermissionDialog({ connectionId, files, onClose, onApply, returnFocus }: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const errorFallback = t("errors.unknown");
  const [entries, setEntries] = useState<RemotePermissionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [recursive, setRecursive] = useState(false);
  const [filePatch, setFilePatch] = useState(emptyPatch);
  const [directoryPatch, setDirectoryPatch] = useState(emptyPatch);
  const [fileValid, setFileValid] = useState(true);
  const [directoryValid, setDirectoryValid] = useState(true);
  const paths = JSON.stringify(files.map(f => f.path));
  useEffect(() => { let active = true; setLoading(true); void api.getRemotePermissions(connectionId, JSON.parse(paths) as string[]).then(result => { if (active)
    setEntries(result); }).catch((e: unknown) => { if (active)
    setError(resolveApiError(e, errorFallback)); }).finally(() => { if (active)
    setLoading(false); }); return () => { active = false; }; }, [connectionId, paths, errorFallback]);
  const { dialogRef, requestClose } = useDialogFocus({ onClose, canClose: !busy, returnFocus });
  const hasDirectories = entries.some(e => e.kind === "folder");
  async function apply() { if (pending.current || loading)
    return; pending.current = true; setBusy(true); setError(null); try {
    await onApply({ paths: files.map(f => f.path), recursive, filePatch, directoryPatch });
    onClose();
  }
  catch (e) {
    setError(resolveApiError(e, t("errors.unknown")));
  }
  finally {
    pending.current = false;
    setBusy(false);
  } }
  const changed = (patch: PermissionPatch, kind: "file" | "folder") => patch.mask !== 0 && (recursive || entries.some(entry => entry.kind === kind && (entry.mode === null || ((entry.mode ^ patch.value) & patch.mask) !== 0)));
  const hasChanges = changed(filePatch, "file") || changed(directoryPatch, "folder");
  const owners = [...new Set(entries.map(e => e.owner))].join(", ");
  const groups = [...new Set(entries.map(e => e.group))].join(", ");
  return <div className="dialog-backdrop file-management-backdrop"><section className="dialog permission-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
  <header className="file-dialog-header"><h2 id={titleId}>{t("fileManagement.permissions")}</h2><button type="button" aria-label={t("sessions.close")} disabled={busy} onClick={requestClose}><X size={18}/></button></header>
  <p className="file-target">{files.length === 1 ? files[0].path : t("fileManagement.selected", { count: files.length })}</p>
  {error && <div className="error-banner" role="alert">{error}</div>}{loading ? <p role="status">{t("fileManagement.loading")}</p> : <>
   <p className="file-target">{t("fileManagement.owner")}: {owners} · {t("fileManagement.group")}: {groups}</p>
   {hasDirectories && <label className="permission-recursive"><input type="checkbox" checked={recursive} disabled={busy} onChange={e => { setRecursive(e.target.checked); setFilePatch(emptyPatch()); setDirectoryPatch(emptyPatch()); setFileValid(true); setDirectoryValid(true); }}/>{t("fileManagement.recursive")}</label>}
   <div className="permission-panels" key={String(recursive)}>
    {(recursive || entries.some(e => e.kind === "file")) && <PermissionGrid label={t("fileManagement.filePermissions")} entries={entries.filter(e => e.kind === "file")} patch={filePatch} onChange={setFilePatch} disabled={busy} onValid={setFileValid}/>}
    {hasDirectories && <PermissionGrid label={t("fileManagement.folderPermissions")} entries={entries.filter(e => e.kind === "folder")} patch={directoryPatch} onChange={setDirectoryPatch} disabled={busy} onValid={setDirectoryValid}/>}
   </div><p className="file-dialog-hint">{t("fileManagement.permissionHint")}</p></>}
  <footer className="file-dialog-footer"><button type="button" disabled={busy} onClick={requestClose}>{t("sessions.cancel")}</button><button type="button" className="primary-button" disabled={busy || loading || !entries.length || !fileValid || !directoryValid || !hasChanges} onClick={() => void apply()}>{t("fileManagement.apply")}</button></footer>
 </section></div>;
}
