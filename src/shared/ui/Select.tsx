import { ChevronDown } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";
import { SelectableOption } from "./SelectableOption";

export interface SelectOption<Value extends string> {
  label: string;
  value: Value;
}

interface SelectProps<Value extends string> {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onChange: (value: Value) => void;
  options: ReadonlyArray<SelectOption<Value>>;
  value: Value;
}

export function Select<Value extends string>({
  ariaLabel,
  className = "",
  disabled = false,
  onChange,
  options,
  value,
}: SelectProps<Value>) {
  const listboxId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [open, setOpen] = useState(false);

  function openMenu() {
    if (disabled || options.length === 0) {
      return;
    }
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function selectOption(index: number) {
    const option = options[index];
    if (!option) {
      return;
    }
    setActiveIndex(index);
    setOpen(false);
    if (option.value !== value) {
      onChange(option.value);
    }
  }

  function moveActive(step: number) {
    if (!open) {
      openMenu();
      return;
    }
    setActiveIndex((index) => (index + step + options.length) % options.length);
  }

  // 焦点保留在触发按钮，通过活动选项关联菜单，避免选项关闭后焦点丢失。
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) {
        selectOption(activeIndex);
      } else {
        openMenu();
      }
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  const selectedOption = options[selectedIndex];

  return (
    <div
      className={`form-select ${className}`.trim()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="text-input form-select-trigger"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
        role="combobox"
        type="button"
      >
        <span>{selectedOption?.label ?? ""}</span>
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      {open ? (
        <div className="form-select-menu" id={listboxId} role="listbox">
          {options.map((option, index) => (
            <SelectableOption
              active={index === activeIndex}
              className="form-select-option"
              id={`${listboxId}-option-${index}`}
              key={option.value}
              label={option.label}
              onClick={() => selectOption(index)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              selected={option.value === value}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
