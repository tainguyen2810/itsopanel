# tests/vm — bộ test VM Phase 4

Chạy **chỉ trên VM Ubuntu 24.04 sạch, dùng một lần** (Multipass hoặc Vagrant). Không chạy trên máy chủ thật.
Hướng dẫn đầy đủ: [`docs/runbooks/phase-4-vm-test.md`](../../docs/runbooks/phase-4-vm-test.md).

| File | Việc |
|---|---|
| `multipass.sh` | Tạo VM 2 vCPU/2 GB, chép release + bộ test, chạy `run-all.sh`, lấy `build/vm-report.md`, xóa VM |
| `Vagrantfile` | Như trên với Vagrant (box `bento/ubuntu-24.04`) |
| `run-all.sh` | Trong VM (root): cài sạch ≤ 10 phút, cài lần 2, doctor, dịch vụ, HTTPS health, cài recipe stress-ng, enforcement, agent từ chối, update → rollback, uninstall giữ `/home` |
| `enforcement.sh` | Bảng `07-HOSTING-ISOLATION.md` §9: CPU throttle, OOM trong slice, TasksMax, EDQUOT, `ls /home/B`, đọc file account khác, `ps aux`, `sudo -l -U itso` |
| `lib/agent_call.py` | Gọi op agent qua unix socket, ký HMAC theo D-66 (cũng dùng để thử ký sai/không ký) |
| `lib/common.sh` | Hàm chung: ghi dòng bảng, chạy lệnh dưới UID account trong slice (`systemd-run --uid --slice`) |

Nhanh: `make release && make test-vm` (cần Multipass). Kết quả là bảng Markdown, dán vào `docs/reports/phase-4.md`.

## Pebble (Phase 5, Prompt 5.4)

| File | Việc |
|---|---|
| `pebble/start.sh` | Chạy Pebble (Docker `ghcr.io/letsencrypt/pebble`, hoặc bản build từ mã nguồn qua `PEBBLE_SRC`), chép CA vào `/etc/itso/acme/pebble-ca.pem` |
| `pebble/run.sh` | Tạo user hệ thống thử, chạy `go test -tags pebble -run TestPebbleIssueReal` dưới root: `cert.issue` (lego thật ↔ Pebble), renew sớm không đổi chứng chỉ, `cert.inspect`, directory ngoài allowlist bị chặn, `cert.remove` |

CI chạy hai script này ở job `pebble` (`.github/workflows/ci.yml`). Pebble đặt `PEBBLE_VA_ALWAYS_VALID=1` vì runner không có DNS cho `*.itso.test`; xác minh HTTP-01 thật qua Nginx kiểm ở `tests/vm/phase5.sh` (5.6).

## Website (Phase 5, Prompt 5.6)

Trong VM đã cài (sau `run-all.sh --release … --no-uninstall`), bằng root:

```bash
ITSO_PEBBLE_VM=1 bash tests/vm/pebble/start.sh   # Pebble + challtestsrv: HTTP-01 thật qua Nginx cổng 80, chứng chỉ hạn 20 ngày
bash tests/vm/phase5.sh                          # → /root/itso-vm-phase5.md
```

| Mã | Kiểm |
|---|---|
| W0 | Cài web stack qua agent: recipe `nginx`, `lego`, `php.version.install` 8.3 |
| W1 | 20 site PHP trên 2 account, mỗi site HTTP 200 và PHP chạy đúng uid account |
| W2 | PHP của account A đọc file của B và `/etc/shadow` bị từ chối (open_basedir + quyền) |
| W3 | Áp vhost khi `nginx -t` lỗi → `config_test_failed`, không còn file vhost mới, 20 site khác vẫn 200 |
| W4 | Pebble cấp chứng chỉ qua HTTP-01 thật (Nginx phục vụ `/.well-known/acme-challenge`), HTTPS dùng chứng chỉ Pebble, `renew` ra chứng chỉ mới |
| W5 | Xóa 20 site không để lại vhost, pool, chứng chỉ, unit; `nginx -t` sạch |
