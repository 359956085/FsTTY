import { confirm, open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, FolderOpen, KeyRound, Save, X } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type {
  CredentialAction,
  CreateSessionPayload,
  SessionAuthInput,
  Session,
  UpdateSessionPayload,
} from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Select } from "../../shared/ui/Select";
import { SelectableOption } from "../../shared/ui/SelectableOption";
import { TextInput } from "../../shared/ui/TextInput";
import { DEFAULT_SESSION_GROUP } from "./constants";

interface SessionFormDialogProps {
  mode: "create" | "edit";
  groupOptions: string[];
  session?: Session;
  saveError?: string | null;
  onClose: () => void;
  onSave: (payload: CreateSessionPayload | UpdateSessionPayload) => Promise<void>;
}

type AuthKind = "password" | "privateKey";
type PrivateKeySource = "file" | "inline";

export function SessionFormDialog({
  groupOptions,
  mode,
  onClose,
  onSave,
  saveError,
  session,
}: SessionFormDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(session?.name ?? "");
  const [host, setHost] = useState(session?.host ?? "");
  const [port, setPort] = useState(String(session?.port ?? 22));
  const [username, setUsername] = useState(session?.username ?? "");
  const [group, setGroup] = useState(
    session?.group === DEFAULT_SESSION_GROUP ? "" : (session?.group ?? ""),
  );
  const [groupActiveIndex, setGroupActiveIndex] = useState(0);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [authKind, setAuthKind] = useState<AuthKind>(
    session?.auth.kind ?? "password",
  );
  const [privateKeySource, setPrivateKeySource] = useState<PrivateKeySource>(
    session?.auth.kind === "privateKey" ? session.auth.source : "file",
  );
  const [privateKeyPath, setPrivateKeyPath] = useState(
    session?.auth.kind === "privateKey" && session.auth.source === "file"
      ? session.auth.path
      : "",
  );
  const [privateKeyContent, setPrivateKeyContent] = useState("");
  const [credential, setCredential] = useState("");
  const [rememberCredential, setRememberCredential] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hostKeyMessage, setHostKeyMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const title = useMemo(
    () => (mode === "create" ? t("sessions.createTitle") : t("sessions.editTitle")),
    [mode, t],
  );
  const availableGroups = useMemo(
    () =>
      Array.from(
        new Set([
          "",
          ...groupOptions
            .map((option) => option.trim())
            .filter((option) => option && option !== DEFAULT_SESSION_GROUP),
        ]),
      ),
    [groupOptions],
  );
  const selectedGroupIndex = availableGroups.findIndex((option) => option === group);

  function openGroupMenu() {
    setGroupActiveIndex(selectedGroupIndex >= 0 ? selectedGroupIndex : 0);
    setGroupMenuOpen(true);
  }

  function moveGroupActive(step: number) {
    if (!groupMenuOpen) {
      openGroupMenu();
      return;
    }
    setGroupActiveIndex(
      (index) => (index + step + availableGroups.length) % availableGroups.length,
    );
  }

  function selectGroupOption(index: number) {
    const option = availableGroups[index];
    if (option === undefined) {
      return;
    }
    setGroup(option);
    setGroupActiveIndex(index);
    setGroupMenuOpen(false);
  }

  function handleGroupInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveGroupActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveGroupActive(-1);
    } else if (event.key === "Enter" && groupMenuOpen) {
      event.preventDefault();
      selectGroupOption(groupActiveIndex);
    } else if (event.key === "Escape" && groupMenuOpen) {
      event.preventDefault();
      setGroupMenuOpen(false);
    }
  }

  function handleGroupToggleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveGroupActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveGroupActive(-1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (groupMenuOpen) {
        selectGroupOption(groupActiveIndex);
      } else {
        openGroupMenu();
      }
    } else if (event.key === "Escape" && groupMenuOpen) {
      event.preventDefault();
      setGroupMenuOpen(false);
    }
  }

  async function choosePrivateKey() {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: t("sessions.selectPrivateKey"),
      });
      if (selected) {
        setPrivateKeyPath(selected);
        setError(null);
      }
    } catch (nextError) {
      setError(resolveApiError(nextError, t("errors.unknown")));
    }
  }

  async function forgetHostKey() {
    if (!session) {
      return;
    }
    try {
      const accepted = await confirm(t("sessions.confirmForgetHostKey"), {
        title: t("sessions.forgetHostKey"),
        kind: "warning",
        okLabel: t("sessions.forget"),
        cancelLabel: t("sessions.cancel"),
      });
      if (!accepted) {
        return;
      }
      const removed = await api.forgetHostKey(session.id);
      setHostKeyMessage(
        removed ? t("sessions.hostKeyForgotten") : t("sessions.hostKeyNotFound"),
      );
    } catch (nextError) {
      setError(resolveApiError(nextError, t("errors.unknown")));
    }
  }

  async function handleSubmit() {
    if (submitting) {
      return;
    }
    const normalizedHost = host.trim();
    const normalizedName = name.trim() || normalizedHost;
    const normalizedPort = Number(port);
    const normalizedUsername = username.trim();
    const normalizedGroup = group.trim();
    const normalizedKeyPath = privateKeyPath.trim();

    if (!normalizedHost) {
      setError(t("sessions.validationRequired"));
      return;
    }
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      setError(t("sessions.validationPort"));
      return;
    }
    if (authKind === "privateKey" && !normalizedUsername) {
      setError(t("sessions.validationPrivateKeyUsername"));
      return;
    }
    const samePassword = mode === "edit" && session?.auth.kind === "password";
    const samePrivateKey =
      mode === "edit" &&
      session?.auth.kind === "privateKey" &&
      session.auth.source === privateKeySource &&
      (session.auth.source === "inline" || session.auth.path === normalizedKeyPath);
    const replacingInlineKey =
      authKind === "privateKey" &&
      privateKeySource === "inline" &&
      privateKeyContent.length > 0;
    const preservingStoredPassword =
      authKind === "password" &&
      rememberCredential &&
      !credential &&
      samePassword &&
      session?.credentialState === "stored";

    if (authKind === "privateKey" && privateKeySource === "file" && !normalizedKeyPath) {
      setError(t("sessions.validationPrivateKey"));
      return;
    }
    if (
      authKind === "privateKey" &&
      privateKeySource === "inline" &&
      !replacingInlineKey &&
      !samePrivateKey
    ) {
      setError(t("sessions.validationInlinePrivateKey"));
      return;
    }

    let credentialAction: CredentialAction;
    if (authKind === "password") {
      if (!normalizedUsername && (Boolean(credential) || preservingStoredPassword)) {
        setError(t("sessions.validationPasswordUsername"));
        return;
      }
      if (!rememberCredential) {
        credentialAction = { mode: "clear" };
      } else if (credential) {
        credentialAction = { mode: "replace", value: credential };
      } else if (preservingStoredPassword) {
        credentialAction = { mode: "preserve" };
      } else {
        credentialAction = { mode: "clear" };
      }
    } else if (credential) {
      credentialAction = rememberCredential
        ? { mode: "replace", value: credential }
        : samePrivateKey && !replacingInlineKey
          ? { mode: "clear" }
          : { mode: "useOnce", value: credential };
    } else if (
      rememberCredential &&
      samePrivateKey &&
      !replacingInlineKey &&
      session?.credentialState !== "missing"
    ) {
      credentialAction = { mode: "preserve" };
    } else if (
      rememberCredential &&
      samePrivateKey &&
      !replacingInlineKey &&
      session?.auth.kind === "privateKey" &&
      session.auth.passphraseRequired
    ) {
      setError(t("sessions.validationPassphrase"));
      return;
    } else {
      credentialAction = { mode: "clear" };
    }

    let auth: SessionAuthInput;
    if (authKind === "password") {
      auth = { kind: "password" };
    } else if (privateKeySource === "file") {
      auth = { kind: "privateKey", source: "file", path: normalizedKeyPath };
    } else {
      auth = {
        kind: "privateKey",
        source: "inline",
        material: replacingInlineKey
          ? { mode: "replace", value: privateKeyContent }
          : { mode: "preserve" },
      };
    }
    const payload: CreateSessionPayload = {
      name: normalizedName,
      host: normalizedHost,
      port: normalizedPort,
      username: normalizedUsername,
      group: normalizedGroup,
      // 表单不再编辑标签；编辑旧会话时保留已有值，避免保存其他字段时意外丢失数据。
      tags: session?.tags ?? [],
      auth,
      credential: credentialAction,
    };
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "edit" && session) {
        await onSave({ ...payload, id: session.id });
      } else {
        await onSave(payload);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop session-dialog-backdrop" role="presentation">
      <section aria-modal="true" className="dialog session-dialog" role="dialog">
        <header className="dialog-header">
          <h2>{title}</h2>
          <button
            aria-label={t("sessions.close")}
            className="icon-button"
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            <X size={18} />
          </button>
        </header>

        <div className="form-grid">
          <label>
            <span>{t("sessions.host")} *</span>
            <TextInput onChange={(event) => setHost(event.target.value)} value={host} />
          </label>
          <label>
            <span>{t("sessions.port")} *</span>
            <TextInput onChange={(event) => setPort(event.target.value)} value={port} />
          </label>
          <label>
            <span>{t("sessions.name")}</span>
            <TextInput onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <label>
            <span>{t("sessions.group")}</span>
            <div
              className="group-combobox"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setGroupMenuOpen(false);
                }
              }}
            >
              <TextInput
                aria-activedescendant={
                  groupMenuOpen ? `session-group-option-${groupActiveIndex}` : undefined
                }
                aria-autocomplete="list"
                aria-controls="session-group-options"
                aria-expanded={groupMenuOpen}
                className="group-combobox-input"
                onChange={(event) => {
                  const nextGroup = event.target.value;
                  const nextIndex = availableGroups.findIndex((option) => option === nextGroup);
                  setGroup(nextGroup);
                  setGroupActiveIndex(nextIndex >= 0 ? nextIndex : 0);
                  setGroupMenuOpen(true);
                }}
                onKeyDown={handleGroupInputKeyDown}
                placeholder={t("sessions.ungrouped")}
                role="combobox"
                value={group}
              />
              <button
                aria-controls="session-group-options"
                aria-expanded={groupMenuOpen}
                aria-haspopup="listbox"
                aria-label={t("sessions.selectGroup")}
                className="group-combobox-toggle"
                onClick={() => (groupMenuOpen ? setGroupMenuOpen(false) : openGroupMenu())}
                onKeyDown={handleGroupToggleKeyDown}
                type="button"
              >
                <ChevronDown size={16} />
              </button>
              {groupMenuOpen ? (
                <div className="group-combobox-menu" id="session-group-options" role="listbox">
                  {availableGroups.map((option, index) => (
                    <SelectableOption
                      active={index === groupActiveIndex}
                      className="group-combobox-option"
                      id={`session-group-option-${index}`}
                      key={option}
                      label={option || t("sessions.ungrouped")}
                      onClick={() => selectGroupOption(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setGroupActiveIndex(index)}
                      selected={option === group}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </label>
          <div className="form-field">
            <span>{t("sessions.authType")}</span>
            <Select<AuthKind>
              ariaLabel={t("sessions.authType")}
              onChange={(nextAuthKind) => {
                setAuthKind(nextAuthKind);
                setCredential("");
                setError(null);
              }}
              options={[
                { value: "password", label: t("sessions.passwordAuth") },
                { value: "privateKey", label: t("sessions.privateKeyAuth") },
              ]}
              value={authKind}
            />
          </div>
          <label>
            <span>
              {t("sessions.username")}
              {authKind === "privateKey" ? " *" : ""}
            </span>
            <TextInput
              onChange={(event) => setUsername(event.target.value)}
              required={authKind === "privateKey"}
              value={username}
            />
          </label>

          {authKind === "password" ? (
            rememberCredential ? (
              <label className="form-wide">
                <span>{t("sessions.password")}</span>
                <TextInput
                  autoComplete="new-password"
                  onChange={(event) => setCredential(event.target.value)}
                  placeholder={
                    mode === "edit" &&
                    session?.auth.kind === "password" &&
                    session.credentialState === "stored"
                      ? t("sessions.keepCredential")
                      : ""
                  }
                  type="password"
                  value={credential}
                />
                <small>{t("sessions.validationCredential")}</small>
              </label>
            ) : null
          ) : (
            <>
              <div className="form-field">
                <span>{t("sessions.privateKeySource")}</span>
                <Select<PrivateKeySource>
                  ariaLabel={t("sessions.privateKeySource")}
                  onChange={(nextPrivateKeySource) => {
                    setPrivateKeySource(nextPrivateKeySource);
                    setCredential("");
                    setError(null);
                  }}
                  options={[
                    { value: "file", label: t("sessions.privateKeyFile") },
                    { value: "inline", label: t("sessions.privateKeyInline") },
                  ]}
                  value={privateKeySource}
                />
              </div>
              <label>
                <span>{t("sessions.passphrase")}</span>
                <TextInput
                  autoComplete="new-password"
                  onChange={(event) => setCredential(event.target.value)}
                  placeholder={
                    mode === "edit" &&
                    session?.auth.kind === "privateKey" &&
                    session.auth.source === privateKeySource
                      ? t("sessions.keepCredential")
                      : t("sessions.optionalPassphrase")
                  }
                  type="password"
                  value={credential}
                />
              </label>
              {privateKeySource === "file" ? (
                <label className="form-wide">
                  <span>{t("sessions.privateKey")} *</span>
                  <span className="file-picker-row">
                    <TextInput readOnly value={privateKeyPath} />
                    <Button
                      className="file-picker-button"
                      icon={<FolderOpen aria-hidden="true" size={16} />}
                      onClick={() => void choosePrivateKey()}
                      variant="ghost"
                    >
                      {t("sessions.browse")}
                    </Button>
                  </span>
                </label>
              ) : (
                <label className="form-wide">
                  <span>{t("sessions.privateKeyInline")} *</span>
                  <textarea
                    className="text-input private-key-content"
                    maxLength={16 * 1024}
                    onChange={(event) => setPrivateKeyContent(event.target.value)}
                    placeholder={
                      mode === "edit" &&
                      session?.auth.kind === "privateKey" &&
                      session.auth.source === "inline"
                        ? t("sessions.keepPrivateKey")
                        : t("sessions.pastePrivateKey")
                    }
                    spellCheck={false}
                    value={privateKeyContent}
                  />
                  <small>{t("sessions.inlinePrivateKeyStoredHint")}</small>
                </label>
              )}
            </>
          )}
          <label className="credential-remember-row form-wide">
            <input
              checked={rememberCredential}
              onChange={(event) => {
                const checked = event.target.checked;
                setRememberCredential(checked);
                if (!checked && authKind === "password") {
                  setCredential("");
                }
              }}
              type="checkbox"
            />
            <span>
              {authKind === "password"
                ? t("sessions.rememberPassword")
                : t("sessions.rememberPassphrase")}
            </span>
          </label>
        </div>

        {session ? (
          <div className="dialog-secondary-action">
            <Button
              icon={<KeyRound aria-hidden="true" size={16} />}
              onClick={() => void forgetHostKey()}
              variant="ghost"
            >
              {t("sessions.forgetHostKey")}
            </Button>
            {hostKeyMessage ? <span>{hostKeyMessage}</span> : null}
          </div>
        ) : null}
        {error ?? saveError ? (
          <div className="form-error">{error ?? saveError}</div>
        ) : null}

        <footer className="dialog-actions">
          <Button
            disabled={submitting}
            icon={<Save aria-hidden="true" size={16} />}
            onClick={() => void handleSubmit()}
          >
            {t("sessions.save")}
          </Button>
        </footer>
      </section>
    </div>
  );
}
