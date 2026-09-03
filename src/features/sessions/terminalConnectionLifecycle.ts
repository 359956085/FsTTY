export interface TerminalConnectionIdentity {
  connectionId: string;
}

export function createTerminalConnectionLifecycle<
  TConnection extends TerminalConnectionIdentity,
  TChannel,
>() {
  let attemptId = 0;
  let channel: TChannel | null = null;
  let connection: TConnection | null = null;
  let connecting = false;
  let disposed = false;

  const invalidate = () => {
    attemptId += 1;
    connecting = false;
    channel = null;
  };

  return {
    canConnect() {
      return !disposed && !connecting && connection === null;
    },
    beginConnect() {
      if (disposed || connecting || connection) {
        return null;
      }
      attemptId += 1;
      connecting = true;
      return attemptId;
    },
    finishConnect(currentAttemptId: number) {
      if (!disposed && attemptId === currentAttemptId) {
        connecting = false;
      }
    },
    isCurrent(currentAttemptId: number) {
      return !disposed && attemptId === currentAttemptId;
    },
    isConnecting() {
      return connecting;
    },
    connection() {
      return connection;
    },
    channel() {
      return channel;
    },
    attachChannel(currentAttemptId: number, nextChannel: TChannel) {
      if (disposed || attemptId !== currentAttemptId) {
        return false;
      }
      channel = nextChannel;
      return true;
    },
    acceptsEvent(
      currentAttemptId: number,
      eventChannel: TChannel,
      eventConnectionId: string,
    ) {
      return (
        !disposed &&
        attemptId === currentAttemptId &&
        channel === eventChannel &&
        (!connection || connection.connectionId === eventConnectionId)
      );
    },
    clearChannel() {
      channel = null;
    },
    setConnection(currentAttemptId: number, nextConnection: TConnection) {
      if (disposed || attemptId !== currentAttemptId) {
        return false;
      }
      connection = nextConnection;
      connecting = false;
      return true;
    },
    reset() {
      const previous = connection;
      connection = null;
      invalidate();
      return previous;
    },
    cancel() {
      invalidate();
    },
    dispose() {
      if (disposed) {
        return null;
      }
      const previous = connection;
      connection = null;
      invalidate();
      disposed = true;
      return previous;
    },
  };
}
