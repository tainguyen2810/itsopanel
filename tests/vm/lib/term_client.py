#!/usr/bin/env python3
"""Client tối thiểu cho socket stream terminal của itso-agent (ADR 0022), dùng trong tests/vm/phase6.sh.

    term_client.py --socket /run/itso/agent-stream.sock <ticket> '<lệnh 1>' ['<lệnh 2>' ...]

Phải chạy dưới uid itso-gw (agent kiểm peercred). Gửi `ATTACH <ticket>`, rồi từng lệnh dạng khung dữ liệu,
in toàn bộ output nhận được ra stdout, cuối cùng gửi `exit` và in lý do đóng (`#EXIT <reason>`).
Khung: [loại 1 byte][độ dài u32 big-endian][payload]; loại 0 = dữ liệu, 1 = resize JSON, 2 = exit JSON.
"""
import argparse
import json
import socket
import struct
import sys
import time


def frame(t: int, payload: bytes) -> bytes:
    return struct.pack(">BI", t, len(payload)) + payload


def read_frames(sock: socket.socket, buf: bytearray, until: float):
    out = []
    sock.settimeout(0.2)
    while time.time() < until:
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            out.append((2, b'{"reason":"eof"}'))
            break
        buf.extend(chunk)
        while len(buf) >= 5:
            t, n = struct.unpack(">BI", bytes(buf[:5]))
            if len(buf) < 5 + n:
                break
            out.append((t, bytes(buf[5:5 + n])))
            del buf[:5 + n]
            if t == 2:
                return out
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket", default="/run/itso/agent-stream.sock")
    ap.add_argument("ticket")
    ap.add_argument("commands", nargs="*")
    a = ap.parse_args()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(a.socket)
    s.sendall(f"ATTACH {a.ticket}\n".encode())
    line = b""
    while not line.endswith(b"\n"):
        c = s.recv(1)
        if not c:
            break
        line += c
    if line.strip() != b"OK":
        print(f"#ATTACH {line.decode(errors='replace').strip()}")
        return 1
    buf = bytearray()
    s.sendall(frame(1, json.dumps({"cols": 120, "rows": 40}).encode()))
    reason = None
    for cmd in a.commands + ["exit"]:
        s.sendall(frame(0, (cmd + "\n").encode()))
        for t, p in read_frames(s, buf, time.time() + 3):
            if t == 0:
                sys.stdout.write(p.decode(errors="replace"))
            elif t == 2:
                reason = json.loads(p or b"{}").get("reason")
        if reason:
            break
    print(f"\n#EXIT {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
