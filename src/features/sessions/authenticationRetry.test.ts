import { describe, expect, it, vi } from "vitest";
import {
  AUTHENTICATION_RETRY_DELAY_MS,
  retryInterruptedAuthentication,
} from "./authenticationRetry";

const interrupted = {
  kind: "authenticationInterrupted",
  message: "SSH 认证连接中断",
};

describe("retryInterruptedAuthentication", () => {
  it("认证连接中断后仅重试一次并返回结果", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(interrupted)
      .mockResolvedValueOnce("connected");
    const wait = vi.fn(async () => undefined);

    await expect(
      retryInterruptedAuthentication(run, () => true, wait),
    ).resolves.toBe("connected");
    expect(run).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(AUTHENTICATION_RETRY_DELAY_MS);
  });

  it("第二次中断直接返回错误", async () => {
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(interrupted);

    await expect(
      retryInterruptedAuthentication(run, () => true, async () => undefined),
    ).rejects.toEqual(interrupted);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("服务器拒绝认证时不重试", async () => {
    const rejected = {
      kind: "authenticationRejected",
      message: "服务器拒绝密码认证",
    };
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(rejected);

    await expect(
      retryInterruptedAuthentication(run, () => true, async () => undefined),
    ).rejects.toEqual(rejected);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("等待期间连接失效时取消第二次请求", async () => {
    let current = true;
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(interrupted);

    await expect(
      retryInterruptedAuthentication(run, () => current, async () => {
        current = false;
      }),
    ).resolves.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("首次请求结束时连接已失效则不等待和重试", async () => {
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(interrupted);
    const wait = vi.fn(async () => undefined);

    await expect(
      retryInterruptedAuthentication(run, () => false, wait),
    ).resolves.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});
