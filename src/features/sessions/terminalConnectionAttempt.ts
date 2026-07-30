export interface TerminalConnectionAttemptGuard {
  begin: () => number;
  invalidate: () => void;
  isCurrent: (attemptId: number) => boolean;
}

export function createTerminalConnectionAttemptGuard(): TerminalConnectionAttemptGuard {
  let currentAttemptId = 0;

  return {
    begin() {
      currentAttemptId += 1;
      return currentAttemptId;
    },
    invalidate() {
      currentAttemptId += 1;
    },
    isCurrent(attemptId) {
      return currentAttemptId === attemptId;
    },
  };
}
