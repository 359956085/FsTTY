export type SessionDragSource =
  | { kind: "group"; groupName: string; groupIndex: number }
  | {
      kind: "session";
      sessionId: string;
      groupName: string;
      sessionIndex: number;
    };

export type SessionDropTarget =
  | { kind: "group"; groupIndex: number; edge: "before" | "after" }
  | {
      kind: "session";
      groupName: string;
      sessionIndex: number;
      edge: "before" | "after";
    }
  | { kind: "groupBody"; groupName: string };

export function resolveSessionDropTarget(
  clientX: number,
  clientY: number,
  source: SessionDragSource,
): SessionDropTarget | null {
  const element = document.elementFromPoint(clientX, clientY);
  if (!(element instanceof HTMLElement)) return null;

  if (source.kind === "group") {
    const groupTitle = element.closest<HTMLElement>("[data-session-drop-group]");
    const groupElement = groupTitle?.closest<HTMLElement>("[data-session-group-index]");
    if (!groupElement || !groupTitle) return null;
    const groupIndex = Number(groupElement.dataset.sessionGroupIndex);
    if (!Number.isInteger(groupIndex)) return null;
    const rectangle = groupTitle.getBoundingClientRect();
    return {
      kind: "group",
      groupIndex,
      edge: clientY < rectangle.top + rectangle.height / 2 ? "before" : "after",
    };
  }

  const sessionElement = element.closest<HTMLElement>("[data-session-index]");
  if (sessionElement) {
    const sessionIndex = Number(sessionElement.dataset.sessionIndex);
    const groupName = sessionElement.dataset.sessionGroupName;
    if (Number.isInteger(sessionIndex) && groupName) {
      const rectangle = sessionElement.getBoundingClientRect();
      return {
        kind: "session",
        groupName,
        sessionIndex,
        edge: clientY < rectangle.top + rectangle.height / 2 ? "before" : "after",
      };
    }
  }

  const groupTitle = element.closest<HTMLElement>("[data-session-drop-group]");
  const groupName = groupTitle?.dataset.sessionDropGroup;
  return groupName ? { kind: "groupBody", groupName } : null;
}
