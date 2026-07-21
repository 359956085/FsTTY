import { readApiError } from "../../shared/api/errors";

export const AUTHENTICATION_RETRY_DELAY_MS = 300;

type Wait = (milliseconds: number) => Promise<void>;

const wait: Wait = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export async function retryInterruptedAuthentication<T>(
  run: () => Promise<T>,
  isCurrent: () => boolean,
  waitForRetry: Wait = wait,
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (readApiError(error, "").kind !== "authenticationInterrupted") {
      throw error;
    }
    if (!isCurrent()) {
      return null;
    }
  }

  await waitForRetry(AUTHENTICATION_RETRY_DELAY_MS);
  if (!isCurrent()) {
    return null;
  }
  // 第二次失败直接交给界面处理，避免错误凭据或异常服务端触发循环重试。
  return run();
}
