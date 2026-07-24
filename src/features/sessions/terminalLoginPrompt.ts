export type TerminalLoginPromptKind = "username" | "password";

export type TerminalLoginInputResult =
  | { kind: "pending"; echo: string }
  | { kind: "submit"; prompt: TerminalLoginPromptKind; value: string; echo: string }
  | { kind: "cancel"; prompt: TerminalLoginPromptKind; echo: string };

const MAX_USERNAME_LENGTH = 128;
const MAX_PASSWORD_LENGTH = 4096;

export function createTerminalLoginInputController() {
  let prompt: TerminalLoginPromptKind | null = null;
  let value = "";

  return {
    start(nextPrompt: TerminalLoginPromptKind) {
      prompt = nextPrompt;
      value = "";
    },
    reset() {
      prompt = null;
      value = "";
    },
    getPrompt() {
      return prompt;
    },
    handle(data: string): TerminalLoginInputResult {
      const activePrompt = prompt;
      if (!activePrompt) {
        return { kind: "pending", echo: "" };
      }
      let echo = "";
      for (const character of data) {
        if (character === "\u001b" || character === "\u0003") {
          prompt = null;
          value = "";
          return { kind: "cancel", prompt: activePrompt, echo: `${echo}\r\n` };
        }
        if (character === "\r" || character === "\n") {
          const submitted = value;
          prompt = null;
          value = "";
          return {
            kind: "submit",
            prompt: activePrompt,
            value: submitted,
            echo: `${echo}\r\n`,
          };
        }
        if (character === "\u007f" || character === "\b") {
          const characters = Array.from(value);
          if (characters.length > 0) {
            characters.pop();
            value = characters.join("");
            if (activePrompt === "username") {
              echo += "\b \b";
            }
          }
          continue;
        }
        if (character < " " || character === "\u007f") {
          continue;
        }
        const maxLength =
          activePrompt === "username" ? MAX_USERNAME_LENGTH : MAX_PASSWORD_LENGTH;
        if (Array.from(value).length >= maxLength) {
          continue;
        }
        value += character;
        if (activePrompt === "username") {
          echo += character;
        }
      }
      return { kind: "pending", echo };
    },
  };
}
