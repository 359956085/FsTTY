export type TerminalInteractionKey = "credential" | "disconnect" | "loginSave" | "trustHost";

export function createTerminalInteractionCoordinator() {
  const generations = new Map<TerminalInteractionKey, number>();
  const pending = new Set<TerminalInteractionKey>();
  let disposed = false;

  const nextGeneration = (key: TerminalInteractionKey) => {
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    return generation;
  };

  return {
    begin(key: TerminalInteractionKey) {
      if (disposed || pending.has(key)) {
        return null;
      }
      const generation = nextGeneration(key);
      pending.add(key);
      return generation;
    },
    cancel(key: TerminalInteractionKey) {
      if (disposed) return;
      nextGeneration(key);
      pending.delete(key);
    },
    finish(key: TerminalInteractionKey, generation: number) {
      if (disposed || generations.get(key) !== generation) {
        return false;
      }
      pending.delete(key);
      return true;
    },
    isCurrent(key: TerminalInteractionKey, generation: number) {
      return !disposed && generations.get(key) === generation;
    },
    dispose() {
      disposed = true;
      pending.clear();
      generations.clear();
    },
  };
}
