import { RotateCcw } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type { AppSettings, ShortcutSettings } from "../../shared/api/types";
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflict,
  formatShortcut,
  shortcutFromEvent,
  shortcutsEqual,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  validateShortcut,
} from "../../shared/shortcuts";
import { Button } from "../../shared/ui/Button";

interface ShortcutSettingsSectionProps {
  onChange: (settings: AppSettings) => void;
  settings: ShortcutSettings;
}

const actionLabelKeys: Record<ShortcutAction, string> = {
  terminalCopy: "settings.shortcutTerminalCopy",
  terminalPaste: "settings.shortcutTerminalPaste",
  commandHistory: "settings.shortcutCommandHistory",
  commandHistorySearch: "settings.shortcutCommandHistorySearch",
};

export function ShortcutSettingsSection({ onChange, settings }: ShortcutSettingsSectionProps) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const lifecycleRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

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
    const validationError = validateShortcut(nextBinding);
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

  function restoreAction(action: ShortcutAction) {
    setRecording(null);
    setError(null);
    if (!shortcutsEqual(settings[action], DEFAULT_SHORTCUTS[action])) {
      void saveShortcuts({ ...settings, [action]: DEFAULT_SHORTCUTS[action] });
    }
  }

  const defaultsActive = SHORTCUT_ACTIONS.every((action) =>
    shortcutsEqual(settings[action], DEFAULT_SHORTCUTS[action]),
  );

  return (
    <section aria-labelledby="shortcut-settings-title" className="settings-panel">
      <header className="settings-panel-header settings-shortcut-header">
        <h3 id="shortcut-settings-title">{t("settings.shortcuts")}</h3>
        <Button
          disabled={busy || defaultsActive}
          icon={<RotateCcw aria-hidden="true" size={14} />}
          onClick={() => void saveShortcuts(DEFAULT_SHORTCUTS)}
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
              onClick={() => {
                setError(null);
                setRecording(action);
              }}
              onKeyDown={(event) => {
                if (recording === action) recordShortcut(action, event);
              }}
              type="button"
            >
              {recording === action
                ? t("settings.shortcutPressKeys")
                : formatShortcut(settings[action])}
            </button>
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
