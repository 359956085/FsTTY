import { describe, expect, it } from "vitest";
import type { Session, SessionGroup } from "../../shared/api/types";
import {
  renameSessionGroup,
  reorderSessionGroups,
  reorderSessionInGroups,
} from "./sessionOrdering";

function session(id: string, group: string): Session {
  return {
    id,
    name: id,
    host: "127.0.0.1",
    port: 22,
    username: "root",
    group,
    tags: [],
    auth: { kind: "password" },
    credentialState: "stored",
    loginSavePrompted: false,
  };
}

function sampleGroups(): SessionGroup[] {
  return [
    { name: "A", sessions: [session("a1", "A"), session("a2", "A")] },
    { name: "B", sessions: [session("b1", "B")] },
    { name: "C", sessions: [session("c1", "C")] },
  ];
}

describe("sessionOrdering", () => {
  it("调整分组顺序并保留组内会话顺序", () => {
    const result = reorderSessionGroups(sampleGroups(), "A", 2);
    expect(result.map((group) => group.name)).toEqual(["B", "C", "A"]);
    expect(result[2].sessions.map((item) => item.id)).toEqual(["a1", "a2"]);
  });

  it("在同一分组内调整会话顺序", () => {
    const result = reorderSessionInGroups(sampleGroups(), "a1", "A", 1);
    expect(result[0].sessions.map((item) => item.id)).toEqual(["a2", "a1"]);
  });

  it("跨组移动会话并移除空分组", () => {
    const result = reorderSessionInGroups(sampleGroups(), "b1", "C", 1);
    expect(result.map((group) => group.name)).toEqual(["A", "C"]);
    expect(result[1].sessions.map((item) => item.id)).toEqual(["c1", "b1"]);
    expect(result[1].sessions[1].group).toBe("C");
  });

  it("重命名分组及其中全部会话", () => {
    const result = renameSessionGroup(sampleGroups(), "A", "生产");
    expect(result[0].name).toBe("生产");
    expect(result[0].sessions.every((item) => item.group === "生产")).toBe(true);
  });
});
