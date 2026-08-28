#!/usr/bin/env python3
"""向常驻监听器发送一次5h锚定请求。"""

from __future__ import annotations

import argparse
from datetime import datetime
from zoneinfo import ZoneInfo
import json
import os
import socket

__author__ = "fengshi"

SOCKET_PATH = os.environ.get("TIBO_QUOTA_SOCKET", "/run/tibo-quota-anchor/control.sock")
ALLOWED_TIMES = {"06:01", "11:05", "16:10"}
MAX_START_DELAY_MINUTES = 20


def main() -> int:
    parser = argparse.ArgumentParser(description="tibo 5h锚定客户端")
    parser.add_argument("slot", choices=sorted(ALLOWED_TIMES))
    arguments = parser.parse_args()
    now = datetime.now(ZoneInfo("Asia/Shanghai"))
    if now.weekday() >= 5:
        raise RuntimeError("北京时间非工作日，拒绝5h锚定")
    hour, minute = (int(value) for value in arguments.slot.split(":"))
    delay_minutes = now.hour * 60 + now.minute - (hour * 60 + minute)
    if not 0 <= delay_minutes <= MAX_START_DELAY_MINUTES:
        raise RuntimeError("当前北京时间不在指定槽开始后的20分钟内")
    slot_key = f"{now:%Y-%m-%d}@{arguments.slot}"
    request = json.dumps({"action": "anchorFiveHour", "slot": slot_key}, ensure_ascii=False) + "\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(370)
        client.connect(SOCKET_PATH)
        client.sendall(request.encode("utf-8"))
        response = b""
        while not response.endswith(b"\n"):
            chunk = client.recv(4096)
            if not chunk:
                break
            response += chunk
    value = json.loads(response.decode("utf-8"))
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0 if value.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
