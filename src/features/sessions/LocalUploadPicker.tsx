import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Folder, File, ChevronUp, X } from "lucide-react";
import { api } from "../../shared/api/client";
import type { LocalUploadDirectory, LocalUploadEntry, LocalUploadLocation } from "../../shared/api/types";
import { resolveApiError } from "../../shared/api/errors";
import { useDialogFocus } from "../../shared/ui/useDialogFocus";
import { formatSize } from "./fileUtils";
import { compactUploadSelection, uploadPathKey } from "./uploadSelection";
interface Props {
  remoteDirectory: string;
  onClose: () => void;
  onUpload: (paths: string[]) => void | Promise<void>;
  returnFocus?: () => HTMLElement | null;
}
export function LocalUploadPicker({ remoteDirectory, onClose, onUpload, returnFocus }: Props) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const readFallback = t("fileManagement.readFailed");
  const [locations, setLocations] = useState<LocalUploadLocation[]>([]);
  const [directory, setDirectory] = useState<LocalUploadDirectory | null>(null);
  const [wanted, setWanted] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<LocalUploadEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const anchor = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const { dialogRef, requestClose } = useDialogFocus({ onClose, canClose: !submitting, returnFocus });
  useEffect(() => { let active = true; void api.getLocalUploadLocations().then(result => { if (active) {
    setLocations(result.locations);
    setWanted(result.initialPath ?? result.locations[0]?.path ?? null);
    if (!result.initialPath && !result.locations.length)
      setLoading(false);
  } }).catch((e: unknown) => { if (active) {
    setError(resolveApiError(e, readFallback));
    setLoading(false);
  } }); return () => { active = false; }; }, [readFallback]);
  useEffect(() => {
    if (!wanted)
      return;
    const token = ++generation.current;
    let active = true;
    setLoading(true);
    setError(null);
    anchor.current = null;
    void api.listLocalUploadEntries(wanted).then(result => { if (active && token === generation.current) {
      setDirectory(result);
      setDraft(result.path);
    } }).catch((e: unknown) => { if (active && token === generation.current)
      setError(resolveApiError(e, readFallback)); }).finally(() => { if (active && token === generation.current)
      setLoading(false); });
    return () => { active = false; };
  }, [wanted, readFallback]);
  const eligible = (directory?.entries ?? []).filter(e => e.kind === "file" || e.kind === "folder");
  function addSelection(additions: LocalUploadEntry[]) {
    const next = [...new Map([...selected, ...additions].map(item => [uploadPathKey(item.path), item])).values()];
    const compact = compactUploadSelection(next);
    if (compact.length > 256) {
      setError(t("fileManagement.tooManyRoots"));
      return;
    }
    setSelected(compact);
  }
  function choose(entry: LocalUploadEntry, range = false) {
    if (loading || submitting || !eligible.includes(entry))
      return;
    const end = eligible.findIndex(e => e.path === entry.path);
    const start = eligible.findIndex(e => e.path === anchor.current);
    const additions = range && start >= 0 ? eligible.slice(Math.min(start, end), Math.max(start, end) + 1) : [entry];
    if (!range && selected.some(e => uploadPathKey(e.path) === uploadPathKey(entry.path))) {
      setSelected(previous => previous.filter(e => uploadPathKey(e.path) !== uploadPathKey(entry.path)));
    }
    else
      addSelection(additions);
    anchor.current = entry.path;
  }
  async function submit() {
    if (!selected.length || submittingRef.current || loading) return;
    const entries = compactUploadSelection(selected);
    if (entries.length > 256) {
      setError(t("fileManagement.tooManyRoots"));
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onUpload(entries.map(entry => entry.path));
      onClose();
    } catch (error) {
      setError(resolveApiError(error, t("errors.unknown")));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
  return <div className="dialog-backdrop file-management-backdrop"><section className="dialog file-picker-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
  <header className="file-dialog-header"><h2 id={titleId}>{t("fileManagement.selectUpload")}</h2><button type="button" aria-label={t("sessions.close")} onClick={requestClose} disabled={submitting}><X size={18}/></button></header>
  <p className="file-target">{t("fileManagement.uploadTarget")} <strong>{remoteDirectory}</strong></p>
  <form className="file-picker-path" onSubmit={e => { e.preventDefault(); if (draft.trim())
    setWanted(draft.trim()); }}>
   <button type="button" aria-label={t("fileManagement.parent")} disabled={!directory?.parent || loading || submitting} onClick={() => setWanted(directory?.parent ?? null)}><ChevronUp size={16}/></button>
   <input aria-label={t("fileManagement.localPath")} value={draft} onChange={e => setDraft(e.target.value)} disabled={submitting}/><button type="submit" disabled={loading || submitting}>{t("fileManagement.go")}</button>
  </form>
  {error && <div role="alert" className="error-banner">{error}</div>}
  <div className="file-picker-browser"><nav aria-label={t("fileManagement.locations")}>{locations.map(location => <button type="button" key={location.label + location.path} disabled={submitting} onClick={() => setWanted(location.path)}>{["home", "desktop", "downloads", "documents"].includes(location.label) ? t("fileManagement." + location.label) : location.label}</button>)}</nav>
   <div className="file-picker-list" role="grid" aria-label={t("fileManagement.localItems")} aria-busy={loading} tabIndex={0} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    if (!loading && !submitting)
      addSelection(eligible);
  } }}>
    <div className="file-picker-columns" role="row"><span>{t("sessions.name")}</span><span>{t("fileManagement.type")}</span><span>{t("sessions.size")}</span><span>{t("sessions.modified")}</span></div>
    {loading ? <p role="status">{t("fileManagement.loading")}</p> : directory?.entries.map(entry => {
      const checked = selected.some(e => uploadPathKey(e.path) === uploadPathKey(entry.path));
      const disabled = entry.kind !== "file" && entry.kind !== "folder";
      return <div role="row" key={entry.path} aria-selected={checked} tabIndex={disabled ? -1 : 0} className={"file-picker-row" + (checked ? " selected" : "") + (disabled ? " unavailable" : "")} onClick={e => choose(entry, e.shiftKey)} onDoubleClick={() => { if (entry.kind === "folder") {
        setSelected(previous => previous.filter(e => e.path !== entry.path));
        setWanted(entry.path);
      } }} onKeyDown={e => { if (e.key === " ") {
        e.preventDefault();
        choose(entry, e.shiftKey);
      }
      else if (e.key === "Enter" && entry.kind === "folder") {
        e.preventDefault();
        setWanted(entry.path);
      } }}>
      <span role="gridcell"><input type="checkbox" aria-label={entry.name} checked={checked} disabled={disabled || submitting} onClick={e => { e.stopPropagation(); choose(entry, e.shiftKey); }} onChange={() => { }}/>{entry.kind === "folder" ? <Folder size={16}/> : <File size={16}/>}<span>{entry.name}</span></span>
      <span role="gridcell">{t("fileManagement." + (entry.kind === "folder" ? "folder" : entry.kind === "file" ? "file" : "unsupported"))}</span><span role="gridcell">{entry.size === null ? "—" : formatSize(entry.size)}</span><span role="gridcell">{entry.modifiedAt === null ? "—" : new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(entry.modifiedAt)}</span>
     </div>;
    })}
    {!loading && directory?.entries.length === 0 && <p>{t("fileManagement.empty")}</p>}
    {directory?.truncated && <p role="status">{t("fileManagement.listTruncated")}</p>}
   </div>
  </div>
  <div className="file-picker-selection"><div><strong>{t("fileManagement.selected", { count: selected.length })}</strong><button type="button" disabled={!selected.length || submitting} onClick={() => setSelected([])}>{t("fileManagement.clearSelection")}</button></div><ul>{selected.map(entry => <li key={entry.path}><span>{entry.path}</span><button type="button" disabled={submitting} aria-label={t("fileManagement.remove", { name: entry.name })} onClick={() => setSelected(previous => previous.filter(e => e.path !== entry.path))}><X size={14}/></button></li>)}</ul></div>
  <footer className="file-dialog-footer"><button type="button" onClick={requestClose} disabled={submitting}>{t("sessions.cancel")}</button><button className="primary-button" type="button" disabled={!selected.length || submitting || loading} onClick={() => void submit()}>{t("fileManagement.uploadCount", { count: compactUploadSelection(selected).length })}</button></footer>
 </section></div>;
}
