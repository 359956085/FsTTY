export interface TerminalConnectionAttemptGuard {
  begin: () => number;
  finish: (attemptId: number) => void;
  invalidate: () => void;
  isConnecting: () => boolean;
  isCurrent: (attemptId: number) => boolean;
}

export function createTerminalConnectionAttemptGuard(): TerminalConnectionAttemptGuard {
  let currentAttemptId = 0;
  let connecting = false;

  return {
    begin() {
      currentAttemptId += 1;
      connecting = true;
      return currentAttemptId;
    },
    finish(attemptId) {
      if (currentAttemptId === attemptId) {
        connecting = false;
      }
    },
    invalidate() {
      currentAttemptId += 1;
      connecting = false;
    },
    isConnecting() {
      return connecting;
    },
    isCurrent(attemptId) {
      return currentAttemptId === attemptId;
    },
  };
}
