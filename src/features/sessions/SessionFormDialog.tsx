import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  onClose: () => void;
  onSave: (payload: CreateSessionPayload | UpdateSessionPayload) => void;
}

export function SessionFormDialog({ mode, onClose, onSave, session }: SessionFormDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(session?.name ?? "");
  const [host, setHost] = useState(session?.host ?? "");
  const [port, setPort] = useState(String(session?.port ?? 22));
  const [username, setUsername] = useState(session?.username ?? "");
  const [group, setGroup] = useState(session?.group ?? "Development");
  const [tags, setTags] = useState(session?.tags.join(", ") ?? "");
  const [error, setError] = useState<string | null>(null);

  const title = useMemo(
    () => (mode === "create" ? t("sessions.createTitle") : t("sessions.editTitle")),
    [mode, t],
  );

  function handleSubmit() {
    const normalizedPort = Number(port);
    const tagList = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);

    if (!name.trim() || !host.trim() || !username.trim()) {
      setError("名称、主机、用户不能为空");
      return;
    }

    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      setError("端口必须在 1 到 65535 之间");
      return;
    }

    const payload = {
      name,
      host,
      port: normalizedPort,
      username,
      group,
      tags: tagList,
    };

    if (mode === "edit" && session) {
      onSave({ ...payload, id: session.id });
      return;
    }

    onSave(payload);
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section aria-modal="true" className="dialog" role="dialog">
        <header className="dialog-header">
          <h2>{title}</h2>
          <button aria-label={t("sessions.close")} className="icon-button" onClick={onClose} type="button">
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
            <TextInput onChange={(event) => setUsername(event.target.value)} value={username} />
          </label>
          <label>
            <span>{t("sessions.group")}</span>
            <TextInput onChange={(event) => setGroup(event.target.value)} value={group} />
          </label>
          <label>
            <span>{t("sessions.tags")}</span>
            <TextInput onChange={(event) => setTags(event.target.value)} value={tags} />
          </label>
        </div>

        {error ? <div className="form-error">{error}</div> : null}

        <footer className="dialog-actions">
          <Button onClick={onClose} variant="ghost">
            {t("sessions.cancel")}
          </Button>
          <Button onClick={handleSubmit}>{t("sessions.save")}</Button>
        </footer>
      </section>
    </div>
  );
}

