import { Check } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

interface SelectableOptionProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "aria-selected" | "children" | "role" | "tabIndex" | "type"
  > {
  active: boolean;
  label: string;
  selected: boolean;
}

export function SelectableOption({
  active,
  className = "",
  label,
  selected,
  ...props
}: SelectableOptionProps) {
  return (
    <button
      {...props}
      aria-selected={selected}
      className={`selectable-option${active ? " active" : ""} ${className}`.trim()}
      role="option"
      tabIndex={-1}
      type="button"
    >
      <span aria-hidden="true" className="selectable-option-indicator">
        {selected ? <Check size={14} /> : null}
      </span>
      <span className="selectable-option-label">{label}</span>
    </button>
  );
}

