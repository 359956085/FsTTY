import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TextInput } from "../../shared/ui/TextInput";
import { SelectableOption } from "../../shared/ui/SelectableOption";
import { isComposingKey } from "../../shared/ui/focus";
import { DEFAULT_SESSION_GROUP } from "./constants";

export function SessionGroupField({ value, onChange, options, disabled = false }: {
  value: string; onChange: (value: string) => void; options: string[]; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const choices = useMemo(() => Array.from(new Set(["", ...options.map((name) => name.trim()).filter((name) => name && name !== DEFAULT_SESSION_GROUP)])), [options]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const show = () => { setActive(Math.max(0, choices.indexOf(value))); setOpen(true); };
  const select = (index: number) => { onChange(choices[index] ?? ""); setOpen(false); };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || isComposingKey(event.nativeEvent) || disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) show(); else setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
    } else if (event.key === "Enter" && open) {
      event.preventDefault(); select(active);
    } else if (event.key === "Escape" && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false);
    }
  };
  return <label><span>{t("sessions.group")}</span><div className="group-combobox"
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <TextInput role="combobox" aria-autocomplete="list" aria-controls={id} aria-expanded={open}
      aria-activedescendant={open ? `${id}-${active}` : undefined} className="group-combobox-input"
      readOnly={disabled} placeholder={t("sessions.ungrouped")} value={value} maxLength={128}
      onKeyDown={keyDown} onChange={(event) => { onChange(event.target.value); setActive(Math.max(0, choices.indexOf(event.target.value))); setOpen(true); }} />
    <button aria-label={t("sessions.selectGroup")} aria-controls={id} aria-expanded={open} aria-haspopup="listbox"
      className="group-combobox-toggle" disabled={disabled} type="button" onKeyDown={keyDown} onClick={() => open ? setOpen(false) : show()}><ChevronDown size={16} /></button>
    {open && <div className="group-combobox-menu" id={id} role="listbox">{choices.map((choice, index) => <SelectableOption key={choice} id={`${id}-${index}`}
      className="group-combobox-option" label={choice || t("sessions.ungrouped")} active={index === active} selected={choice === value}
      onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => select(index)} />)}</div>}
  </div></label>;
}
