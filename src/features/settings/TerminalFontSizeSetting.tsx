import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_TERMINAL_FONT_SIZE, isTerminalFontSize, MAX_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE } from "../../shared/terminalFontSize";
import { TextInput } from "../../shared/ui/TextInput";

export function TerminalFontSizeSetting({ value = DEFAULT_TERMINAL_FONT_SIZE, onChange, saving = false }: {
  value?: number;
  onChange?: (value: number) => void;
  saving?: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(String(value)); setInvalid(false); }, [value]);
  function commit() {
    const size = draft.trim() === "" ? NaN : Number(draft);
    if (!isTerminalFontSize(size)) { setInvalid(true); return; }
    setInvalid(false);
    setDraft(String(size));
    onChange?.(size);
  }
  return <div className="settings-row">
    <div className="settings-row-copy">
      <label className="settings-row-label" htmlFor="terminal-font-size">{t("settings.terminalFontSize")}</label>
      <small id="terminal-font-size-hint">{t("settings.terminalFontSizeHint")}</small>
      {invalid && <small id="terminal-font-size-error" role="alert">{t("settings.terminalFontSizeInvalid")}</small>}
    </div>
    <TextInput id="terminal-font-size" className="settings-font-size-input" type="number"
      min={MIN_TERMINAL_FONT_SIZE} max={MAX_TERMINAL_FONT_SIZE} step={1} value={draft}
      aria-busy={saving} aria-invalid={invalid} disabled={!onChange}
      aria-describedby={`terminal-font-size-hint${invalid ? " terminal-font-size-error" : ""}`}
      onChange={(event) => { setDraft(event.target.value); setInvalid(false); }} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commit(); }
        if (event.key === "Escape") { setDraft(String(value)); setInvalid(false); }
      }} />
  </div>;
}
