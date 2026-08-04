import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type { McpTransport } from "./McpConfigDialog";
import type { McpPermissionTooltipState } from "./McpPermissionTooltip";

type McpPromptState<T> = Record<McpTransport, T>;

const initialBooleanState: McpPromptState<boolean> = { http: false, stdio: false };
const initialErrorState: McpPromptState<string | null> = { http: null, stdio: null };

export function useMcpPromptCopy(
  setTooltip: Dispatch<SetStateAction<McpPermissionTooltipState | null>>,
) {
  const { t } = useTranslation();
  const [copying, setCopying] = useState(initialBooleanState);
  const [copied, setCopied] = useState(initialBooleanState);
  const [error, setError] = useState(initialErrorState);
  const inFlightRef = useRef<McpPromptState<boolean>>({ http: false, stdio: false });
  const copiedTimerRef = useRef<Partial<McpPromptState<number>>>({});

  useEffect(
    () => () => {
      for (const timer of Object.values(copiedTimerRef.current)) {
        window.clearTimeout(timer);
      }
    },
    [],
  );

  async function copy(transport: McpTransport, target: HTMLButtonElement) {
    if (inFlightRef.current[transport]) return;
    inFlightRef.current[transport] = true;
    setCopying((current) => ({ ...current, [transport]: true }));
    setCopied((current) => ({ ...current, [transport]: false }));
    setError((current) => ({ ...current, [transport]: null }));
    const previousTimer = copiedTimerRef.current[transport];
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
      delete copiedTimerRef.current[transport];
    }
    try {
      await writeText(await api.getMcpAgentPrompt());
      setCopied((current) => ({ ...current, [transport]: true }));
      const tooltipKey = `${transport}-agent-prompt-copy`;
      const bounds = target.getBoundingClientRect();
      setTooltip({
        key: tooltipKey,
        text: t("settings.mcpPromptCopied"),
        anchor: {
          bottom: bounds.bottom,
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
        },
      });
      copiedTimerRef.current[transport] = window.setTimeout(() => {
        setCopied((current) => ({ ...current, [transport]: false }));
        setTooltip((current) => (current?.key === tooltipKey ? null : current));
        delete copiedTimerRef.current[transport];
      }, 2_000);
    } catch (nextError) {
      setError((current) => ({
        ...current,
        [transport]: resolveApiError(nextError, t("settings.mcpPromptCopyFailed")),
      }));
    } finally {
      inFlightRef.current[transport] = false;
      setCopying((current) => ({ ...current, [transport]: false }));
    }
  }

  return { copied, copying, copy, error };
}
