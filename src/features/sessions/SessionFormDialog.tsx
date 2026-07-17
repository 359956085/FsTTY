import { confirm } from "@tauri-apps/plugin-dialog";
import { ChevronDown, KeyRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../shared/api/client";
import { resolveApiError } from "../../shared/api/errors";
import type {
  CreateSessionPayload,
  Session,
  UpdateSessionPayload,
} from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { TextInput } from "../../shared/ui/TextInput";

interface SessionFormDialogProps {
  mode: "create" | "edit";
  groupOptions: string[];
  session?: Session;
  saveError?: string | null;
  onClose: () => void;
  onSave: (payload: CreateSessionPayload | UpdateSessionPayload) => Promise<void>;
}

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
  const [group, setGroup] = useState(session?.group ?? "未分组");
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [credential, setCredential] = useState("");
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
        new Set(["未分组", ...groupOptions.map((option) => option.trim()).filter(Boolean)]),
      ),
    [groupOptions],
  );

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

    if (!normalizedHost) {
      setError(t("sessions.validationRequired"));
      return;
    }
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      setError(t("sessions.validationPort"));
      return;
    }
    const sameAuth = mode === "edit" && session?.auth.kind === "password";
    const credentialAction = credential
      ? { mode: "replace" as const, value: credential }
      : sameAuth
        ? { mode: "preserve" as const }
        : { mode: "clear" as const };
    const payload: CreateSessionPayload = {
      name: normalizedName,
      host: normalizedHost,
      port: normalizedPort,
      username: normalizedUsername,
      group: normalizedGroup,
      // 表单不再编辑标签；编辑旧会话时保留已有值，避免保存其他字段时意外丢失数据。
      tags: session?.tags ?? [],
      auth: { kind: "password" },
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
                aria-autocomplete="list"
                aria-controls="session-group-options"
                aria-expanded={groupMenuOpen}
                className="group-combobox-input"
                onChange={(event) => {
                  setGroup(event.target.value);
                  setGroupMenuOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setGroupMenuOpen(true);
                  } else if (event.key === "Escape") {
                    setGroupMenuOpen(false);
                  }
                }}
                role="combobox"
                value={group}
              />
              <button
                aria-label={t("sessions.selectGroup")}
                className="group-combobox-toggle"
                onClick={() => setGroupMenuOpen((open) => !open)}
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >
                <ChevronDown size={16} />
              </button>
              {groupMenuOpen ? (
                <div className="group-combobox-menu" id="session-group-options" role="listbox">
                  {availableGroups.map((option) => (
                    <button
                      aria-selected={option === group}
                      className={
                        option === group
                          ? "group-combobox-option selected"
                          : "group-combobox-option"
                      }
                      key={option}
                      onClick={() => {
                        setGroup(option);
                        setGroupMenuOpen(false);
                      }}
                      role="option"
                      type="button"
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </label>
          <label>
            <span>{t("sessions.host")} *</span>
            <TextInput onChange={(event) => setHost(event.target.value)} value={host} />
          </label>
          <label>
            <span>{t("sessions.port")} *</span>
            <TextInput onChange={(event) => setPort(event.target.value)} value={port} />
          </label>
          <label>
            <span>{t("sessions.username")}</span>
            <TextInput
              onChange={(event) => setUsername(event.target.value)}
              value={username}
            />
          </label>
          <label>
            <span>{t("sessions.password")}</span>
            <TextInput
              autoComplete="new-password"
              onChange={(event) => setCredential(event.target.value)}
              placeholder={mode === "edit" ? t("sessions.keepCredential") : ""}
              type="password"
              value={credential}
            />
          </label>
        </div>

        {session ? (
          <div className="dialog-secondary-action">
            <Button
              icon={<KeyRound size={16} />}
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
          <Button disabled={submitting} onClick={() => void handleSubmit()}>
            {t("sessions.save")}
          </Button>
        </footer>
      </section>
    </div>
  );
}
