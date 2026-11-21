#!/usr/bin/env python3
"""Gọi một op của itso-agent qua unix socket, ký HMAC đúng D-66 (chỉ dùng cho bộ test VM).

    agent_call.py [--socket S] [--key-file K] [--no-sign] <op> '<params JSON>'

In ra JSON {"http": <mã HTTP>, "body": <kết quả agent>} và thoát 0 khi gửi được (kể cả khi agent từ chối):
script gọi tự đánh giá `ok`/`error.code`. Không có trong release; không chạy lệnh hệ thống.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import http.client
import json
import secrets
import socket
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float = 120):
        super().__init__("agent", timeout=timeout)
        self.unix_path = path

    def connect(self) -> None:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self.unix_path)
        self.sock = s


def canonical(method: str, path: str, ts: int, nonce: str, body: bytes) -> str:
    return "\n".join(["v1", method, path, str(ts), nonce, hashlib.sha256(body).hexdigest()])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket", default="/run/itso/agent.sock")
    ap.add_argument("--key-file", default="/etc/itso/agent.key")
    ap.add_argument("--no-sign", action="store_true", help="không ký (kiểm agent từ chối)")
    ap.add_argument("--bad-sign", action="store_true", help="ký sai khóa (kiểm agent từ chối)")
    ap.add_argument("--op-id", default=None)
    ap.add_argument("--timeout", type=float, default=120)
    ap.add_argument("op")
    ap.add_argument("params")
    a = ap.parse_args()

    now = int(time.time())
    env = {
        "v": 1,
        "op": a.op,
        "op_id": a.op_id or f"{uuid.uuid4()}:1:0",
        "params": json.loads(a.params),
        "deadline": (datetime.now(timezone.utc) + timedelta(seconds=a.timeout)).isoformat(timespec="seconds"),
        "ts": now,
        "nonce": secrets.token_urlsafe(18),
        "requested_by": {"user_uuid": None, "role": "SYSTEM"},
    }
    body = json.dumps(env, separators=(",", ":")).encode()
    headers = {"Content-Type": "application/json"}
    if not a.no_sign:
        with open(a.key_file, "rb") as f:
            key = f.read().strip()
        if a.bad_sign:
            key = b"x" * 32
        nonce = secrets.token_urlsafe(18)
        sig = hmac.new(key, canonical("POST", "/v1/ops", now, nonce, body).encode(), hashlib.sha256).hexdigest()
        headers.update({"X-ITSO-Signature": sig, "X-ITSO-Timestamp": str(now), "X-ITSO-Nonce": nonce})
    c = UnixHTTPConnection(a.socket, a.timeout)
    try:
        c.request("POST", "/v1/ops", body=body, headers=headers)
        r = c.getresponse()
        raw = r.read()
    except OSError as e:
        print(json.dumps({"http": 0, "body": None, "error": str(e)}))
        return 2
    try:
        parsed = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        parsed = raw.decode(errors="replace")
    print(json.dumps({"http": r.status, "body": parsed}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
