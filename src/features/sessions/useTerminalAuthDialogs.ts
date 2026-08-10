import { useCallback, useState } from "react";
import type { HostKeyChallenge, HostKeyChange } from "../../shared/api/types";
import type { TerminalLoginPromptKind } from "./terminalLoginPrompt";

export type LoginSavePromptKind = "username" | "password" | "both";

export function useTerminalAuthDialogs() {
  const [hostKeyChallenge, setHostKeyChallenge] = useState<HostKeyChallenge | null>(null);
  const [hostKeyChange, setHostKeyChange] = useState<HostKeyChange | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [credentialPrompt, setCredentialPrompt] =
    useState<"privateKeyPassphrase" | null>(null);
  const [credentialValue, setCredentialValue] = useState("");
  const [rememberCredential, setRememberCredential] = useState(true);
  const [credentialSubmitting, setCredentialSubmitting] = useState(false);
  const [terminalLoginPrompt, setTerminalLoginPrompt] =
    useState<TerminalLoginPromptKind | null>(null);
  const [loginSavePrompt, setLoginSavePrompt] = useState<LoginSavePromptKind | null>(null);
  const [loginSaveSubmitting, setLoginSaveSubmitting] = useState(false);
  const [loginSaveError, setLoginSaveError] = useState<string | null>(null);

  const cancelCredentialPrompt = useCallback(() => {
    setCredentialPrompt(null);
    setCredentialValue("");
    setDialogError(null);
    setCredentialSubmitting(false);
  }, []);

  const clearLoginPrompts = useCallback(() => {
    setTerminalLoginPrompt(null);
    setLoginSavePrompt(null);
    setLoginSaveError(null);
    setLoginSaveSubmitting(false);
  }, []);

  return {
    cancelCredentialPrompt,
    clearLoginPrompts,
    credentialPrompt,
    credentialSubmitting,
    credentialValue,
    dialogError,
    hostKeyChallenge,
    hostKeyChange,
    loginSaveError,
    loginSavePrompt,
    loginSaveSubmitting,
    rememberCredential,
    setCredentialPrompt,
    setCredentialSubmitting,
    setCredentialValue,
    setDialogError,
    setHostKeyChallenge,
    setHostKeyChange,
    setLoginSaveError,
    setLoginSavePrompt,
    setLoginSaveSubmitting,
    setRememberCredential,
    setTerminalLoginPrompt,
    terminalLoginPrompt,
  };
}
