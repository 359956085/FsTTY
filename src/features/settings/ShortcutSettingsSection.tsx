import { Eraser, RotateCcw } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ShortcutBinding } from "../../shared/api/types";
import { createWheelStepAccumulator, wheelShortcutFromEvent } from "../../shared/wheelShortcuts";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type { AppSettings, ShortcutSettings } from "../../shared/api/types";
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflict,
  isFontShortcutAction,
  formatShortcut,
  shortcutFromEvent,
  shortcutsEqual,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  validateShortcut,
} from "../../shared/shortcuts";
import { Button } from "../../shared/ui/Button";
import { TooltipButton } from "../../shared/ui/TooltipButton";

interface ShortcutSettingsSectionProps {
  onChange: (settings: AppSettings) => void;
  settings: ShortcutSettings;
}

const actionLabelKeys: Record<ShortcutAction, string> = {
  terminalCopy: "settings.shortcutTerminalCopy",
  terminalPaste: "settings.shortcutTerminalPaste",
  commandHistory: "settings.shortcutCommandHistory",
  commandHistorySearch: "settings.shortcutCommandHistorySearch",
  newSession: "settings.shortcutNewSession",
  nextTab: "settings.shortcutNextTab",
  previousTab: "settings.shortcutPreviousTab",
  terminalFontIncrease: "settings.shortcutTerminalFontIncrease",
  terminalFontDecrease: "settings.shortcutTerminalFontDecrease",
};

export function ShortcutSettingsSection({ onChange, settings }: ShortcutSettingsSectionProps) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const lifecycleRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const recordWheelRef = useRef<(event: WheelEvent) => void>(() => {});
  const wheelAccumulatorRef = useRef(createWheelStepAccumulator());

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const listener = (event: WheelEvent) => recordWheelRef.current(event);
    section.addEventListener("wheel", listener, { capture: true, passive: false });
    return () => section.removeEventListener("wheel", listener, true);
  }, []);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    return () => {
      if (lifecycleRef.current === lifecycle) lifecycleRef.current += 1;
      busyRef.current = false;
    };
  }, []);

  async function saveShortcuts(next: ShortcutSettings) {
    if (busyRef.current) return;
    const lifecycle = lifecycleRef.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const nextSettings = await api.updateShortcutSettings(next);
      if (lifecycleRef.current === lifecycle) onChange(nextSettings);
    } catch (nextError) {
      if (lifecycleRef.current === lifecycle) {
        setError(resolveApiError(nextError, t("settings.shortcutSaveFailed")));
      }
    } finally {
      busyRef.current = false;
      if (lifecycleRef.current === lifecycle) setBusy(false);
    }
  }

  function recordShortcut(action: ShortcutAction, event: KeyboardEvent<HTMLButtonElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      setRecording(null);
      setError(null);
      return;
    }
    if (event.metaKey) {
      setError(t("settings.shortcutMetaUnsupported"));
      return;
    }
    const nextBinding = shortcutFromEvent(event.nativeEvent);
    if (!nextBinding) return;
    acceptBinding(action, nextBinding);
  }

  function acceptBinding(action: ShortcutAction, nextBinding: ShortcutBinding) {
    const validationError = validateShortcut(nextBinding, action);
    if (validationError) {
      setError(t(`settings.shortcut${capitalize(validationError)}`));
      return;
    }
    const conflict = findShortcutConflict(settings, action, nextBinding);
    if (conflict) {
      setError(
        t("settings.shortcutConflict", {
          action: t(actionLabelKeys[conflict]),
        }),
      );
      return;
    }
    setRecording(null);
    if (!shortcutsEqual(settings[action], nextBinding)) {
      void saveShortcuts({ ...settings, [action]: nextBinding });
    }
  }

  recordWheelRef.current = (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-shortcut-action]") : null;
    if (!recording || !isFontShortcutAction(recording) || busyRef.current || button?.getAttribute("data-shortcut-action") !== recording) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.metaKey) { setError(t("settings.shortcutMetaUnsupported")); return; }
    const binding = wheelShortcutFromEvent(event);
    if (!binding || !wheelAccumulatorRef.current(event)) return;
    acceptBinding(recording, binding);
  };

  function restoreAction(action: ShortcutAction) {
    setRecording(null);
    setError(null);
    const binding = DEFAULT_SHORTCUTS[action];
    const conflict = binding && findShortcutConflict(settings, action, binding);
    if (conflict) { setError(t("settings.shortcutConflict", { action: t(actionLabelKeys[conflict]) })); return; }
    if (!shortcutsEqual(settings[action], binding)) {
      void saveShortcuts({ ...settings, [action]: DEFAULT_SHORTCUTS[action] });
    }
  }

  const defaultsActive = SHORTCUT_ACTIONS.every((action) =>
    shortcutsEqual(settings[action], DEFAULT_SHORTCUTS[action]),
  );

  return (
    <section ref={sectionRef} aria-labelledby="shortcut-settings-title" className="settings-panel">
      <header className="settings-panel-header settings-shortcut-header">
        <h3 id="shortcut-settings-title">{t("settings.shortcuts")}</h3>
        <Button
          disabled={busy || defaultsActive}
          icon={<RotateCcw aria-hidden="true" size={14} />}
          onClick={() => { setRecording(null); void saveShortcuts(DEFAULT_SHORTCUTS); }}
          variant="ghost"
        >
          {t("settings.shortcutRestoreAll")}
        </Button>
      </header>
      {SHORTCUT_ACTIONS.map((action, index) => (
        <div
          className={`settings-row settings-shortcut-row${index === SHORTCUT_ACTIONS.length - 1 ? " settings-shortcut-row-last" : ""}`}
          key={action}
        >
          <span className="settings-row-label">{t(actionLabelKeys[action])}</span>
          <div className="settings-shortcut-controls">
            <button
              aria-label={t("settings.shortcutEdit", { action: t(actionLabelKeys[action]) })}
              className={`settings-shortcut-key${recording === action ? " recording" : ""}`}
              disabled={busy}
              data-shortcut-action={action}
              onClick={() => {
                setError(null);
                wheelAccumulatorRef.current = createWheelStepAccumulator();
                setRecording(action);
              }}
              onKeyDown={(event) => {
                if (recording === action) recordShortcut(action, event);
              }}
              type="button"
            >
              {recording === action
                ? t(isFontShortcutAction(action) ? "settings.shortcutPressKeysOrWheel" : "settings.shortcutPressKeys")
                : settings[action] ? formatShortcut(settings[action], { WheelUp: t("settings.shortcutWheelUp"), WheelDown: t("settings.shortcutWheelDown") }) : t("settings.shortcutUnbound")}
            </button>
            {(["newSession", "nextTab", "previousTab", "terminalFontIncrease", "terminalFontDecrease"] as string[]).includes(action) && (
              <TooltipButton className="settings-shortcut-reset"
                disabled={busy || !settings[action]}
                label={t("settings.shortcutClearHint")}
                aria-label={t("settings.shortcutClear", { action: t(actionLabelKeys[action]) })}
                onClick={() => { setRecording(null); void saveShortcuts({ ...settings, [action]: null }); }}>
                <Eraser aria-hidden="true" size={14} />
              </TooltipButton>
            )}
            <button
              aria-label={t("settings.shortcutRestore", { action: t(actionLabelKeys[action]) })}
              className="settings-shortcut-reset"
              disabled={busy || shortcutsEqual(settings[action], DEFAULT_SHORTCUTS[action])}
              onClick={() => restoreAction(action)}
              title={t("settings.shortcutRestore", { action: t(actionLabelKeys[action]) })}
              type="button"
            >
              <RotateCcw aria-hidden="true" size={14} />
            </button>
          </div>
        </div>
      ))}
      {error ? (
        <div className="form-error settings-error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}

function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
