import type { FileEntry } from "../../shared/api/types";
import { isSlowRenameClick, type FileNameClick } from "./fileUtils";
import { normalizeRemoteEntryName } from "./fileOperationController";

export interface InlineRenameState {
  error: string | null;
  file: FileEntry;
  value: string;
}

interface InlineRenameControllerOptions {
  onChange: (state: InlineRenameState | null) => void;
  onFocusRequested: () => void;
  onPendingChange: (pending: boolean) => void;
}

interface SubmitInlineRenameOptions {
  formatError: (error: unknown) => string;
  rename: (path: string, newName: string) => Promise<void>;
  requiredError: string;
}

export function createInlineRenameController(
  options: InlineRenameControllerOptions,
) {
  let current: InlineRenameState | null = null;
  let previousClick: FileNameClick | null = null;
  let generation = 0;
  let pending = false;
  let disposed = false;

  const publish = (state: InlineRenameState | null) => {
    current = state;
    if (!disposed) options.onChange(state);
  };

  const cancelRequest = () => {
    generation += 1;
    if (pending) {
      pending = false;
      if (!disposed) options.onPendingChange(false);
    }
  };

  return {
    begin(file: FileEntry) {
      if (disposed || current) return false;
      previousClick = null;
      publish({ file, value: file.name, error: null });
      return true;
    },
    cancel() {
      if (disposed) return;
      previousClick = null;
      cancelRequest();
      publish(null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      pending = false;
      current = null;
      previousClick = null;
    },
    reconcile(files: FileEntry[], loading: boolean) {
      if (
        current &&
        !loading &&
        !files.some((file) => file.path === current?.file.path)
      ) {
        this.cancel();
      }
    },
    registerNameClick(
      file: FileEntry,
      selectedPath: string | null,
      currentClick: FileNameClick,
      detail: number,
      blocked: boolean,
    ) {
      const shouldRename =
        !blocked &&
        selectedPath === file.path &&
        isSlowRenameClick(previousClick, currentClick, detail);
      previousClick = shouldRename ? null : currentClick;
      return shouldRename;
    },
    resetClick() {
      previousClick = null;
    },
    async submit(submitOptions: SubmitInlineRenameOptions) {
      if (disposed || !current || pending) return false;
      const submitted = current;
      const newName = normalizeRemoteEntryName(submitted.value);
      if (!newName) {
        publish({ ...submitted, error: submitOptions.requiredError });
        options.onFocusRequested();
        return false;
      }
      if (newName === submitted.file.name) {
        this.cancel();
        return false;
      }

      const requestGeneration = ++generation;
      pending = true;
      publish({ ...submitted, value: newName, error: null });
      options.onPendingChange(true);
      try {
        await submitOptions.rename(submitted.file.path, newName);
        if (!disposed && generation === requestGeneration) publish(null);
      } catch (error) {
        if (!disposed && generation === requestGeneration) {
          publish({
            ...submitted,
            value: newName,
            error: submitOptions.formatError(error),
          });
          options.onFocusRequested();
        }
      } finally {
        if (!disposed && generation === requestGeneration) {
          pending = false;
          options.onPendingChange(false);
        }
      }
      return true;
    },
    update(value: string) {
      if (!disposed && current) publish({ ...current, value, error: null });
    },
  };
}
