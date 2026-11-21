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
