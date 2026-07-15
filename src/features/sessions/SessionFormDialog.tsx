import { confirm, open } from "@tauri-apps/plugin-dialog";
import { KeyRound, X } from "lucide-react";
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
  session?: Session;
  saveError?: string | null;
  onClose: () => void;
  onSave: (payload: CreateSessionPayload | UpdateSessionPayload) => Promise<void>;
}

export function SessionFormDialog({
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
  const [tags, setTags] = useState(session?.tags.join(", ") ?? "");
  const [authKind, setAuthKind] = useState<"password" | "privateKey">(
    session?.auth.kind ?? "password",
  );
  const [privateKeyPath, setPrivateKeyPath] = useState(
    session?.auth.kind === "privateKey" ? session.auth.path : "",
  );
  const [credential, setCredential] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hostKeyMessage, setHostKeyMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const title = useMemo(
    () => (mode === "create" ? t("sessions.createTitle") : t("sessions.editTitle")),
    [mode, t],
  );

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
    const normalizedName = name.trim();
    const normalizedHost = host.trim();
    const normalizedPort = Number(port);
    const normalizedUsername = username.trim();
    const normalizedGroup = group.trim();
    const normalizedKeyPath = privateKeyPath.trim();
    const tagList = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);

    if (!normalizedName || !normalizedHost || !normalizedUsername) {
      setError(t("sessions.validationRequired"));
      return;
    }
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      setError(t("sessions.validationPort"));
      return;
    }
    if (authKind === "privateKey" && !normalizedKeyPath) {
      setError(t("sessions.validationPrivateKey"));
      return;
    }

    const sameAuth =
      mode === "edit" &&
      session &&
      session.auth.kind === authKind &&
      (authKind !== "privateKey" ||
        (session.auth.kind === "privateKey" && session.auth.path === normalizedKeyPath));
    if (authKind === "password" && !credential && !sameAuth) {
      setError(t("sessions.validationCredential"));
      return;
    }
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
      tags: tagList,
      auth:
        authKind === "password"
          ? { kind: "password" }
          : { kind: "privateKey", path: normalizedKeyPath },
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
    <div className="dialog-backdrop" role="presentation">
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
            <span>{t("sessions.host")}</span>
            <TextInput onChange={(event) => setHost(event.target.value)} value={host} />
          </label>
          <label>
            <span>{t("sessions.port")}</span>
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
            <span>{t("sessions.group")}</span>
            <TextInput onChange={(event) => setGroup(event.target.value)} value={group} />
          </label>
          <label>
            <span>{t("sessions.tags")}</span>
            <TextInput onChange={(event) => setTags(event.target.value)} value={tags} />
          </label>
          <label>
            <span>{t("sessions.authType")}</span>
            <select
              className="text-input"
              onChange={(event) =>
                setAuthKind(event.target.value as "password" | "privateKey")
              }
              value={authKind}
            >
              <option value="password">{t("sessions.passwordAuth")}</option>
              <option value="privateKey">{t("sessions.privateKeyAuth")}</option>
            </select>
          </label>
          <label>
            <span>
              {authKind === "password"
                ? t("sessions.password")
                : t("sessions.passphrase")}
            </span>
            <TextInput
              autoComplete="new-password"
              onChange={(event) => setCredential(event.target.value)}
              placeholder={mode === "edit" ? t("sessions.keepCredential") : ""}
              type="password"
              value={credential}
            />
          </label>
          {authKind === "privateKey" ? (
            <label className="form-wide">
              <span>{t("sessions.privateKey")}</span>
              <span className="file-picker-row">
                <TextInput readOnly value={privateKeyPath} />
                <Button onClick={() => void choosePrivateKey()} variant="ghost">
                  {t("sessions.browse")}
                </Button>
              </span>
            </label>
          ) : null}
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
          <Button disabled={submitting} onClick={onClose} variant="ghost">
            {t("sessions.cancel")}
          </Button>
          <Button disabled={submitting} onClick={() => void handleSubmit()}>
            {t("sessions.save")}
          </Button>
        </footer>
      </section>
    </div>
  );
}
