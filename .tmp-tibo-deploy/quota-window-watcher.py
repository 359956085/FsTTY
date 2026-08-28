#!/usr/bin/env python3
"""常驻监听周额度，并通过本机 Socket 执行工作日 5h 锚定。"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import resource
import time
from typing import Any

__author__ = "fengshi"

WORK_DIR = Path(os.environ.get("TIBO_QUOTA_WORK_DIR", "/home/ubuntu/codex-quota-ping"))
STATE_FILE = WORK_DIR / "quota-window-state.json"
LOG_FILE = WORK_DIR / "quota-window.log"
LAST_MESSAGE_FILE = WORK_DIR / "last-message.txt"
SOCKET_PATH = Path(os.environ.get("TIBO_QUOTA_SOCKET", "/run/tibo-quota-anchor/control.sock"))
CODEX_COMMAND = os.environ.get("TIBO_CODEX_COMMAND", "/usr/local/bin/codex")

FIVE_HOUR_WINDOW_MINS = 300
WEEKLY_WINDOW_MINS = 10_080
POLL_SECONDS = int(os.environ.get("TIBO_POLL_SECONDS", "60"))
EMPTY_CONFIRM_SECONDS = int(os.environ.get("TIBO_EMPTY_CONFIRM_SECONDS", "5"))
VERIFY_INTERVAL_SECONDS = int(os.environ.get("TIBO_VERIFY_INTERVAL_SECONDS", "30"))
VERIFY_TOTAL_SECONDS = int(os.environ.get("TIBO_VERIFY_TOTAL_SECONDS", "300"))
RESET_TOLERANCE_SECONDS = 5
REQUEST_TIMEOUT_SECONDS = 30
TURN_TIMEOUT_SECONDS = 240
RESOURCE_LOG_SECONDS = 3600
MAX_SLOT_HISTORY = 90

ANCHOR_PROMPT = """本次任务仅用于确认当前时间，不得修改任何文件。必须使用 Shell 分别执行 `/usr/bin/date -u -Is` 和 `env TZ=Asia/Shanghai /usr/bin/date '+%F %T %Z'`。根据真实命令结果，用200到300个简体中文字符说明 UTC 时间、北京时间、八小时时差以及日期是否跨日。不得只回复数字1，不得省略命令执行。"""


def build_logger() -> logging.Logger:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("tibo-quota-anchor")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s%(message)s", "%Y-%m-%dT%H:%M:%S%z ")
    file_handler = RotatingFileHandler(
        LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    logger.addHandler(stream_handler)
    return logger


LOGGER = build_logger()


def default_weekly_state() -> dict[str, Any]:
    return {
        "status": "pending",
        "anchorSource": None,
        "generation": 0,
        "lastAttemptGeneration": None,
        "attemptedAt": None,
        "verifiedAt": None,
        "lastConfirmedResetsAt": None,
        "lastObservedAt": None,
        "lastObservedResetsAt": None,
        "lastUsedPercent": None,
        "stableCount": 0,
        "zeroCount": 0,
        "failureReason": None,
        "lastTokenUsage": None,
    }


def default_state() -> dict[str, Any]:
    return {
        "version": 3,
        "weekly": default_weekly_state(),
        "fiveHour": {"slots": {}},
        "appServerRestartCount": 0,
        "lastObservedAt": None,
    }


def migrate_state(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("version") == 3:
        state = default_state()
        state.update(value)
        weekly = default_weekly_state()
        if isinstance(value.get("weekly"), dict):
            weekly.update(value["weekly"])
        state["weekly"] = weekly
        if not isinstance(state.get("fiveHour"), dict):
            state["fiveHour"] = {"slots": {}}
        state["fiveHour"].setdefault("slots", {})
    else:
        # 旧版只有周窗口；迁移时保留已确认状态，但丢弃不稳定的原始去重键。
        state = default_state()
        weekly = state["weekly"]
        weekly.update(
            {
                "status": value.get("status", "pending"),
                "anchorSource": value.get("anchorSource"),
                "generation": max(1, int(value.get("windowGeneration") or 0)),
                "lastConfirmedResetsAt": value.get("lastConfirmedResetsAt"),
                "lastObservedAt": value.get("lastObservedAt"),
                "lastObservedResetsAt": value.get("lastObservedResetsAt"),
                "lastUsedPercent": value.get("lastUsedPercent"),
                "stableCount": int(value.get("stableCount") or 0),
                "zeroCount": int(value.get("zeroCount") or 0),
                "failureReason": value.get("failureReason"),
                "lastTokenUsage": value.get("lastTokenUsage"),
            }
        )
        # 旧版可能已经重复请求；迁移后当前逻辑代不再自动请求。
        if value.get("lastAttemptAt") is not None:
            weekly["lastAttemptGeneration"] = weekly["generation"]
            weekly["attemptedAt"] = value.get("lastAttemptAt")
        state["appServerRestartCount"] = int(value.get("appServerRestartCount") or 0)
    if state["weekly"].get("status") == "anchoring":
        state["weekly"]["status"] = "failed"
        state["weekly"]["failureReason"] = "上次锚定过程中服务中断"
    for slot in state["fiveHour"]["slots"].values():
        if isinstance(slot, dict) and slot.get("status") == "anchoring":
            slot["status"] = "failed"
            slot["failureReason"] = "上次锚定过程中服务中断"
    return state


def load_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return default_state()
    try:
        value = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"状态文件读取失败：{error}") from error
    if not isinstance(value, dict):
        raise RuntimeError("状态文件根节点必须是对象")
    return migrate_state(value)


def save_state(state: dict[str, Any]) -> None:
    slots = state.setdefault("fiveHour", {}).setdefault("slots", {})
    if len(slots) > MAX_SLOT_HISTORY:
        for key in sorted(slots)[:-MAX_SLOT_HISTORY]:
            del slots[key]
    temporary = STATE_FILE.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    os.replace(temporary, STATE_FILE)


def reset_matches(first: Any, second: Any) -> bool:
    return (
        isinstance(first, int)
        and isinstance(second, int)
        and abs(first - second) <= RESET_TOLERANCE_SECONDS
    )


def extract_windows(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    limits = result.get("rateLimitsByLimitId", {}).get("codex") or result.get("rateLimits") or {}
    found: dict[str, dict[str, Any]] = {}
    for window in (limits.get("primary"), limits.get("secondary")):
        if not isinstance(window, dict):
            continue
        duration = window.get("windowDurationMins")
        key = "weekly" if duration == WEEKLY_WINDOW_MINS else "fiveHour" if duration == FIVE_HOUR_WINDOW_MINS else None
        if key is None:
            continue
        used = window.get("usedPercent")
        resets_at = window.get("resetsAt")
        if not isinstance(used, (int, float)) or not isinstance(resets_at, (int, float)):
            raise RuntimeError(f"{duration}分钟窗口字段缺失或格式错误")
        found[key] = {
            "usedPercent": float(used),
            "resetsAt": int(resets_at),
            "windowDurationMins": int(duration),
        }
    if "weekly" not in found or "fiveHour" not in found:
        raise RuntimeError("额度响应必须同时包含300和10080分钟窗口")
    return found


def observe_weekly(state: dict[str, Any], window: dict[str, Any], now: int) -> str:
    weekly = state["weekly"]
    used = window["usedPercent"]
    resets_at = window["resetsAt"]
    previous_used = weekly.get("lastUsedPercent")
    previous_reset = weekly.get("lastObservedResetsAt")
    weekly["lastObservedAt"] = now

    if used > 0:
        same = reset_matches(previous_reset, resets_at)
        weekly["stableCount"] = int(weekly.get("stableCount") or 0) + 1 if same else 1
        weekly["zeroCount"] = 0
        weekly["lastUsedPercent"] = used
        weekly["lastObservedResetsAt"] = resets_at
        if weekly["stableCount"] >= 2:
            same_confirmed_window = reset_matches(weekly.get("lastConfirmedResetsAt"), resets_at)
            if weekly.get("status") not in ("anchoring", "verifying", "verified") or not same_confirmed_window:
                weekly["anchorSource"] = "external"
            weekly["status"] = "verified"
            weekly["verifiedAt"] = now
            weekly["lastConfirmedResetsAt"] = resets_at
            weekly["failureReason"] = None
            return "verified"
        return "confirm_usage"

    crossed_boundary = (
        isinstance(previous_reset, int)
        and not reset_matches(previous_reset, resets_at)
        and now >= previous_reset - RESET_TOLERANCE_SECONDS
    )
    first_generation = int(weekly.get("generation") or 0) == 0
    confirmed_reset = weekly.get("lastConfirmedResetsAt")
    transition_from_usage = (
        isinstance(previous_used, (int, float))
        and previous_used > 0
        and (
            (isinstance(confirmed_reset, int) and now >= confirmed_reset - RESET_TOLERANCE_SECONDS)
            or crossed_boundary
        )
    )
    if first_generation or crossed_boundary or transition_from_usage:
        weekly["generation"] = int(weekly.get("generation") or 0) + 1
        weekly["status"] = "pending"
        weekly["anchorSource"] = None
        weekly["zeroCount"] = 1
        weekly["failureReason"] = None
    else:
        weekly["zeroCount"] = int(weekly.get("zeroCount") or 0) + 1
    weekly["stableCount"] = 0
    weekly["lastUsedPercent"] = used
    weekly["lastObservedResetsAt"] = resets_at
    if weekly["zeroCount"] < 2:
        return "confirm_empty"
    if weekly.get("lastAttemptGeneration") == weekly["generation"]:
        return "observe_empty"
    return "anchor"


class AppServerClient:
    def __init__(self) -> None:
        self.process: asyncio.subprocess.Process | None = None
        self.reader_task: asyncio.Task[None] | None = None
        self.stderr_task: asyncio.Task[None] | None = None
        self.pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self.turn_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.completed_turns: dict[str, dict[str, Any]] = {}
        self.next_request_id = 1
        self.notification_event = asyncio.Event()
        self.ignore_rate_notifications_until = 0.0
        self.active_anchor_thread: str | None = None
        self.latest_token_usage: dict[str, Any] | None = None
        self.last_agent_message = ""

    async def start(self) -> None:
        self.process = await asyncio.create_subprocess_exec(
            CODEX_COMMAND, "app-server", "--listen", "stdio://",
            cwd=str(WORK_DIR), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        self.reader_task = asyncio.create_task(self._read_stdout())
        self.stderr_task = asyncio.create_task(self._read_stderr())
        await self.request("initialize", {"clientInfo": {
            "name": "tibo_quota_anchor", "title": "tibo 额度锚定器", "version": "3.0.0"
        }})
        await self.notify("initialized", {})

    async def stop(self) -> None:
        if self.process is not None and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        for task in (self.reader_task, self.stderr_task):
            if task is None:
                continue
            if not task.done():
                task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def request(self, method: str, params: dict[str, Any] | None = None,
                      timeout: int = REQUEST_TIMEOUT_SECONDS) -> dict[str, Any]:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("App Server 未启动")
        request_id = self.next_request_id
        self.next_request_id += 1
        payload: dict[str, Any] = {"id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode())
        await self.process.stdin.drain()
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self.pending.pop(request_id, None)

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("App Server 未启动")
        self.process.stdin.write((json.dumps({"method": method, "params": params}) + "\n").encode())
        await self.process.stdin.drain()

    async def read_windows(self) -> dict[str, dict[str, Any]]:
        self.ignore_rate_notifications_until = time.monotonic() + 3
        return extract_windows(await self.request("account/rateLimits/read"))

    async def wait_turn(self, turn_id: str) -> dict[str, Any]:
        completed = self.completed_turns.pop(turn_id, None)
        if completed is not None:
            return completed
        future = asyncio.get_running_loop().create_future()
        self.turn_waiters[turn_id] = future
        try:
            return await asyncio.wait_for(future, timeout=TURN_TIMEOUT_SECONDS)
        finally:
            self.turn_waiters.pop(turn_id, None)

    async def _read_stdout(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        try:
            while True:
                raw = await self.process.stdout.readline()
                if not raw:
                    raise RuntimeError("App Server 提前退出")
                message = json.loads(raw.decode("utf-8"))
                request_id = message.get("id")
                if isinstance(request_id, int) and request_id in self.pending:
                    future = self.pending[request_id]
                    if "error" in message:
                        error = message["error"]
                        detail = error.get("message", str(error)) if isinstance(error, dict) else str(error)
                        future.set_exception(RuntimeError(detail))
                    else:
                        future.set_result(message.get("result") or {})
                    continue
                self._handle_notification(message)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(RuntimeError(f"App Server 连接中断：{error}"))
            raise

    async def _read_stderr(self) -> None:
        assert self.process is not None and self.process.stderr is not None
        while True:
            raw = await self.process.stderr.readline()
            if not raw:
                return
            message = raw.decode("utf-8", errors="replace").strip()
            if message:
                LOGGER.warning("App Server：%s", message)

    def _handle_notification(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        params = message.get("params") or {}
        if method == "account/rateLimits/updated":
            if time.monotonic() >= self.ignore_rate_notifications_until:
                self.notification_event.set()
            return
        if method == "turn/completed":
            turn = params.get("turn") or {}
            turn_id = turn.get("id")
            if isinstance(turn_id, str):
                waiter = self.turn_waiters.get(turn_id)
                if waiter is not None and not waiter.done():
                    waiter.set_result(turn)
                else:
                    self.completed_turns[turn_id] = turn
            return
        if method == "thread/tokenUsage/updated" and params.get("threadId") == self.active_anchor_thread:
            self.latest_token_usage = params
            return
        if method == "item/completed" and params.get("threadId") == self.active_anchor_thread:
            item = params.get("item") or {}
            if item.get("type") == "agentMessage" and isinstance(item.get("text"), str):
                self.last_agent_message = item["text"]


async def run_anchor_turn(client: AppServerClient) -> dict[str, Any] | None:
    thread_id: str | None = None
    try:
        thread_result = await client.request("thread/start", {"cwd": str(WORK_DIR)})
        thread_id = (thread_result.get("thread") or {}).get("id")
        if not isinstance(thread_id, str) or not thread_id:
            raise RuntimeError("thread/start 未返回线程 ID")
        client.active_anchor_thread = thread_id
        client.latest_token_usage = None
        client.last_agent_message = ""
        turn_result = await client.request("turn/start", {
            "threadId": thread_id,
            "input": [{"type": "text", "text": ANCHOR_PROMPT}],
            "cwd": str(WORK_DIR),
            "approvalPolicy": "never",
            "sandboxPolicy": {"type": "readOnly"},
            "effort": "low",
            "summary": "concise",
        })
        turn_id = (turn_result.get("turn") or {}).get("id")
        if not isinstance(turn_id, str) or not turn_id:
            raise RuntimeError("turn/start 未返回任务 ID")
        try:
            turn = await client.wait_turn(turn_id)
        except asyncio.TimeoutError as error:
            with contextlib.suppress(Exception):
                await client.request("turn/interrupt", {"threadId": thread_id, "turnId": turn_id})
            raise RuntimeError("模型锚定请求超时") from error
        if turn.get("status") != "completed":
            detail = (turn.get("error") or {}).get("message") or turn.get("status")
            raise RuntimeError(f"模型锚定请求未完成：{detail}")
        if client.last_agent_message:
            temporary = LAST_MESSAGE_FILE.with_suffix(".txt.tmp")
            temporary.write_text(client.last_agent_message, encoding="utf-8")
            os.chmod(temporary, 0o600)
            os.replace(temporary, LAST_MESSAGE_FILE)
        LOGGER.info("模型请求完成：输出字符数=%d，token=%s", len(client.last_agent_message),
                    json.dumps(client.latest_token_usage, ensure_ascii=False, separators=(",", ":")))
        return client.latest_token_usage
    finally:
        client.active_anchor_thread = None
        if thread_id is not None:
            with contextlib.suppress(Exception):
                await client.request("thread/archive", {"threadId": thread_id})


class Coordinator:
    def __init__(self, client: AppServerClient) -> None:
        self.client = client
        self.state_lock = asyncio.Lock()
        self.anchor_lock = asyncio.Lock()

    async def evaluate_weekly(self) -> None:
        windows = await self.client.read_windows()
        now = int(time.time())
        async with self.state_lock:
            state = load_state()
            action = observe_weekly(state, windows["weekly"], now)
            state["lastObservedAt"] = now
            save_state(state)
        if action == "confirm_empty":
            LOGGER.info("周窗口0%%：%d秒后复查", EMPTY_CONFIRM_SECONDS)
            await asyncio.sleep(EMPTY_CONFIRM_SECONDS)
            windows = await self.client.read_windows()
            async with self.state_lock:
                state = load_state()
                action = observe_weekly(state, windows["weekly"], int(time.time()))
                save_state(state)
        if action == "anchor":
            await self._anchor_weekly()
        elif action == "verified":
            LOGGER.info("周窗口已固定：usedPercent=%g，resetsAt=%d", windows["weekly"]["usedPercent"], windows["weekly"]["resetsAt"])

    async def _anchor_weekly(self) -> None:
        async with self.anchor_lock:
            windows = await self.client.read_windows()
            if windows["weekly"]["usedPercent"] > 0:
                await self._record_weekly_observation(windows["weekly"])
                return
            async with self.state_lock:
                state = load_state()
                weekly = state["weekly"]
                generation = int(weekly.get("generation") or 0)
                if weekly.get("lastAttemptGeneration") == generation:
                    return
                weekly.update({
                    "status": "anchoring", "anchorSource": "script",
                    "lastAttemptGeneration": generation, "attemptedAt": int(time.time()),
                    "failureReason": None,
                })
                save_state(state)
            LOGGER.info("周窗口：开始第%d逻辑代唯一锚定请求", generation)
            try:
                token_usage = await run_anchor_turn(self.client)
                async with self.state_lock:
                    state = load_state()
                    state["weekly"]["status"] = "verifying"
                    state["weekly"]["lastTokenUsage"] = token_usage
                    save_state(state)
                await self._verify_after_turn(None, verify_weekly=True)
            except Exception as error:
                async with self.state_lock:
                    state = load_state()
                    state["weekly"]["status"] = "failed"
                    state["weekly"]["failureReason"] = str(error)
                    save_state(state)
                LOGGER.exception("周窗口锚定失败：%s", error)

    async def _record_weekly_observation(self, window: dict[str, Any]) -> None:
        async with self.state_lock:
            state = load_state()
            observe_weekly(state, window, int(time.time()))
            save_state(state)

    async def anchor_five_hour(self, slot_key: str) -> dict[str, Any]:
        if not valid_slot_key(slot_key):
            raise RuntimeError("slot 必须是北京时间工作日 YYYY-MM-DD@06:01/11:05/16:10")
        async with self.anchor_lock:
            async with self.state_lock:
                state = load_state()
                existing = state["fiveHour"]["slots"].get(slot_key)
                if isinstance(existing, dict):
                    return {"status": existing.get("status"), "duplicate": True, "slot": slot_key}
            windows = await self.client.read_windows()
            now = int(time.time())
            five = windows["fiveHour"]
            async with self.state_lock:
                state = load_state()
                weekly_action = observe_weekly(state, windows["weekly"], now)
                slot = {
                    "status": "pending", "anchorSource": None, "attemptedAt": None,
                    "verifiedAt": None, "usedPercent": five["usedPercent"],
                    "resetsAt": five["resetsAt"], "failureReason": None,
                }
                state["fiveHour"]["slots"][slot_key] = slot
                save_state(state)

            if five["usedPercent"] > 0 and five["resetsAt"] > now:
                await asyncio.sleep(EMPTY_CONFIRM_SECONDS)
                second = (await self.client.read_windows())["fiveHour"]
                async with self.state_lock:
                    state = load_state()
                    slot = state["fiveHour"]["slots"][slot_key]
                    slot.update({"usedPercent": second["usedPercent"], "resetsAt": second["resetsAt"]})
                    if second["usedPercent"] > 0 and reset_matches(five["resetsAt"], second["resetsAt"]):
                        slot.update({"status": "verified", "anchorSource": "external", "verifiedAt": int(time.time())})
                    else:
                        slot.update({"status": "failed", "failureReason": "外部用量窗口未连续稳定"})
                    save_state(state)
                LOGGER.info("5h槽%s：已有真实用量，状态=%s，跳过模型请求", slot_key, slot["status"])
                return {"status": slot["status"], "duplicate": False, "slot": slot_key}

            async with self.state_lock:
                state = load_state()
                slot = state["fiveHour"]["slots"][slot_key]
                slot.update({"status": "anchoring", "anchorSource": "script", "attemptedAt": now})
                weekly = state["weekly"]
                include_weekly = windows["weekly"]["usedPercent"] <= 0 and weekly_action in ("anchor", "confirm_empty", "observe_empty")
                if include_weekly and weekly.get("lastAttemptGeneration") != weekly.get("generation"):
                    weekly.update({
                        "status": "anchoring", "anchorSource": "shared",
                        "lastAttemptGeneration": weekly["generation"], "attemptedAt": now,
                        "failureReason": None,
                    })
                else:
                    include_weekly = False
                save_state(state)
            LOGGER.info("5h槽%s：开始唯一锚定请求，合并周窗口=%s", slot_key, "是" if include_weekly else "否")
            try:
                token_usage = await run_anchor_turn(self.client)
                async with self.state_lock:
                    state = load_state()
                    state["fiveHour"]["slots"][slot_key]["status"] = "verifying"
                    state["fiveHour"]["slots"][slot_key]["lastTokenUsage"] = token_usage
                    if include_weekly:
                        state["weekly"]["status"] = "verifying"
                        state["weekly"]["lastTokenUsage"] = token_usage
                    save_state(state)
                await self._verify_after_turn(slot_key, include_weekly)
            except Exception as error:
                async with self.state_lock:
                    state = load_state()
                    slot = state["fiveHour"]["slots"][slot_key]
                    slot["status"] = "failed"
                    slot["failureReason"] = str(error)
                    if include_weekly:
                        state["weekly"]["status"] = "failed"
                        state["weekly"]["failureReason"] = str(error)
                    save_state(state)
                LOGGER.exception("5h槽%s锚定失败：%s", slot_key, error)
            state = load_state()
            return {"status": state["fiveHour"]["slots"][slot_key]["status"], "duplicate": False, "slot": slot_key}

    async def _verify_after_turn(self, slot_key: str | None, verify_weekly: bool) -> None:
        deadline = time.monotonic() + VERIFY_TOTAL_SECONDS
        stable: dict[str, tuple[int | None, int]] = {
            "fiveHour": (None, 0), "weekly": (None, 0)
        }
        verified_five = slot_key is None
        verified_weekly = not verify_weekly
        while time.monotonic() < deadline and not (verified_five and verified_weekly):
            await asyncio.sleep(VERIFY_INTERVAL_SECONDS)
            windows = await self.client.read_windows()
            now = int(time.time())
            async with self.state_lock:
                state = load_state()
                if slot_key is not None and not verified_five:
                    verified_five = self._apply_verification(state, "fiveHour", windows["fiveHour"], stable, now, slot_key)
                if verify_weekly and not verified_weekly:
                    verified_weekly = self._apply_verification(state, "weekly", windows["weekly"], stable, now, None)
                save_state(state)
        async with self.state_lock:
            state = load_state()
            if slot_key is not None and not verified_five:
                slot = state["fiveHour"]["slots"][slot_key]
                slot["status"] = "failed"
                slot["failureReason"] = "5分钟内未确认5h窗口"
            if verify_weekly and not verified_weekly:
                state["weekly"]["status"] = "failed"
                state["weekly"]["failureReason"] = "5分钟内未确认周窗口"
            save_state(state)

    @staticmethod
    def _apply_verification(state: dict[str, Any], key: str, window: dict[str, Any],
                            stable: dict[str, tuple[int | None, int]], now: int,
                            slot_key: str | None) -> bool:
        last_reset, count = stable[key]
        if window["usedPercent"] <= 0:
            stable[key] = (None, 0)
            return False
        count = count + 1 if last_reset is not None and reset_matches(last_reset, window["resetsAt"]) else 1
        stable[key] = (window["resetsAt"], count)
        if count < 2:
            return False
        if key == "weekly":
            weekly = state["weekly"]
            weekly.update({
                "status": "verified", "verifiedAt": now,
                "lastConfirmedResetsAt": window["resetsAt"],
                "lastObservedResetsAt": window["resetsAt"],
                "lastObservedAt": now, "lastUsedPercent": window["usedPercent"],
                "stableCount": 2, "zeroCount": 0, "failureReason": None,
            })
        else:
            assert slot_key is not None
            state["fiveHour"]["slots"][slot_key].update({
                "status": "verified", "verifiedAt": now,
                "usedPercent": window["usedPercent"], "resetsAt": window["resetsAt"],
                "failureReason": None,
            })
        LOGGER.info("%s验证成功：usedPercent=%g，resetsAt=%d", key, window["usedPercent"], window["resetsAt"])
        return True


def valid_slot_key(slot_key: str) -> bool:
    try:
        date_text, slot_time = slot_key.split("@", 1)
        parsed = time.strptime(date_text, "%Y-%m-%d")
    except (ValueError, TypeError):
        return False
    return parsed.tm_wday < 5 and slot_time in {"06:01", "11:05", "16:10"}


async def handle_socket(reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
                        coordinator: Coordinator) -> None:
    try:
        raw = await asyncio.wait_for(reader.readline(), timeout=10)
        request = json.loads(raw.decode("utf-8"))
        if request.get("action") != "anchorFiveHour":
            raise RuntimeError("不支持的 action")
        result = await coordinator.anchor_five_hour(str(request.get("slot", "")))
        response = {"ok": True, **result}
    except Exception as error:
        LOGGER.exception("控制请求失败：%s", error)
        response = {"ok": False, "error": str(error)}
    writer.write((json.dumps(response, ensure_ascii=False) + "\n").encode())
    with contextlib.suppress(Exception):
        await writer.drain()
    writer.close()
    with contextlib.suppress(Exception):
        await writer.wait_closed()


def process_tree_rss_mb(root_pid: int) -> float:
    parents: dict[int, int] = {}
    rss_kb: dict[int, int] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            values = (entry / "status").read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError):
            continue
        pid = int(entry.name)
        for line in values:
            if line.startswith("PPid:"):
                parents[pid] = int(line.split()[1])
            elif line.startswith("VmRSS:"):
                rss_kb[pid] = int(line.split()[1])
    descendants = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, parent in parents.items():
            if parent in descendants and pid not in descendants:
                descendants.add(pid)
                changed = True
    return sum(rss_kb.get(pid, 0) for pid in descendants) / 1024


def log_resources(state: dict[str, Any]) -> None:
    usage = resource.getrusage(resource.RUSAGE_SELF)
    child = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu_seconds = usage.ru_utime + usage.ru_stime + child.ru_utime + child.ru_stime
    LOGGER.info("资源心跳：rss=%.1fMB，cpu累计=%.1fs，AppServer启动次数=%d，周状态=%s",
                process_tree_rss_mb(os.getpid()), cpu_seconds,
                int(state.get("appServerRestartCount") or 0), state["weekly"].get("status"))


async def monitor(client: AppServerClient, coordinator: Coordinator) -> None:
    await coordinator.evaluate_weekly()
    next_resource_log = time.monotonic()
    while True:
        if client.reader_task is not None and client.reader_task.done():
            await client.reader_task
        now = time.monotonic()
        if now >= next_resource_log:
            log_resources(load_state())
            next_resource_log = now + RESOURCE_LOG_SECONDS
        wait_seconds = min(POLL_SECONDS, max(1.0, next_resource_log - now))
        try:
            await asyncio.wait_for(client.notification_event.wait(), timeout=wait_seconds)
            client.notification_event.clear()
            LOGGER.info("收到额度变更通知：复查周窗口")
        except asyncio.TimeoutError:
            pass
        await coordinator.evaluate_weekly()


async def run_daemon() -> None:
    backoff = 1
    while True:
        client = AppServerClient()
        server: asyncio.AbstractServer | None = None
        try:
            await client.start()
            state = load_state()
            state["appServerRestartCount"] = int(state.get("appServerRestartCount") or 0) + 1
            save_state(state)
            coordinator = Coordinator(client)
            SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
            with contextlib.suppress(FileNotFoundError):
                SOCKET_PATH.unlink()
            server = await asyncio.start_unix_server(
                lambda reader, writer: handle_socket(reader, writer, coordinator), path=str(SOCKET_PATH)
            )
            os.chmod(SOCKET_PATH, 0o600)
            LOGGER.info("App Server和控制Socket已就绪：%s", SOCKET_PATH)
            backoff = 1
            await monitor(client, coordinator)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            LOGGER.exception("服务连接失败：%s；%d秒后重试", error, backoff)
        finally:
            if server is not None:
                server.close()
                await server.wait_closed()
            with contextlib.suppress(FileNotFoundError):
                SOCKET_PATH.unlink()
            await client.stop()
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="tibo 周额度监听与5h锚定器")
    parser.add_argument("--daemon", action="store_true", required=True)
    return parser.parse_args()


def main() -> int:
    parse_arguments()
    try:
        asyncio.run(run_daemon())
    except KeyboardInterrupt:
        LOGGER.info("收到停止信号，退出")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
