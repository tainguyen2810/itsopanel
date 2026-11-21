# Runbook: kiểm thử Phase 4 trên VM

Mục đích: chạy các tiêu chí nghiệm thu Phase 4 cần máy Linux thật (systemd, cgroup v2, quota kernel) trên **VM Ubuntu 24.04 sạch, dùng một lần**. Không chạy trên máy chủ thật, không chạy trên máy dev.

## 1. Chuẩn bị

| Việc | Lệnh / ghi chú |
|---|---|
| Máy dev có Multipass (khuyến nghị) | `snap install multipass` (Linux) hoặc bản cài macOS/Windows từ multipass.run |
| Hoặc Vagrant + VirtualBox/libvirt | box `bento/ubuntu-24.04` |
| Bản release đã ký | `make release` → `build/release/<phiên bản>/` (khóa dev tạm nếu không đặt `ITSO_RELEASE_KEY`) |
| Bản release thứ hai (để thử update → rollback, tùy chọn) | `make release VERSION=<bản cao hơn>` |

Cấu hình VM do script tạo: 2 vCPU, 2 GB RAM, 20 GB đĩa (đúng điều kiện "cài sạch ≤ 10 phút" của 11-ROADMAP).

## 2. Chạy

```bash
make release
make test-vm                                    # bản release mới nhất trong build/release/
make test-vm RELEASE=build/release/0.4.0-dev VM_ARGS="--release2 build/release/0.4.1-dev --keep"
```

Hoặc bằng Vagrant:

```bash
cd tests/vm && ITSO_RELEASE=../../build/release/0.4.0-dev vagrant up && vagrant destroy -f
```

`run-all.sh` chạy bằng root trong VM và ghi báo cáo `/root/itso-vm-report.md`; `multipass.sh` lấy về `build/vm-report.md` rồi xóa VM (trừ khi `--keep`).

## 3. Các mục được kiểm

| Mã | Kiểm | Đạt khi |
|---|---|---|
| V1 | `install.sh` trên máy sạch | xong ≤ 600 s, chữ ký release hợp lệ |
| V2 | Cài lần 2 | idempotent, giữ `/etc/itso/agent.key` |
| V3 | `itso doctor` | không có mục đỏ |
| V4 | Unit systemd | `itso.target`, agent, web, worker, scheduler active |
| V5 | HTTPS health | `/api/v1/system/health` trả 200 |
| V6 | Cài recipe `stress-ng` qua agent | job `software.install` thành công |
| E0 | Tạo account A (uid 20001), B (20002) qua agent | `account.ensure`, `account.limits.apply`, `quota.apply` ok |
| E1 | CPU throttle | `cpu.stat` có `nr_throttled > 0` khi chạy stress-ng vượt CPUQuota |
| E2 | Hết RAM | OOM chỉ giết tiến trình trong slice của account |
| E3 | TasksMax 64 | fork thứ 65 thất bại |
| E4 | Vượt quota đĩa | `EDQUOT` (chế độ `soft`: chỉ cảnh báo, ghi WARN) |
| E5 | `ls /home/B` dưới UID A | bị từ chối |
| E6 | Đọc file của B dưới UID A | bị từ chối |
| E7 | `ps` dưới UID A | không thấy tiến trình của B (`hidepid`) |
| E8 | `sudo -l -U itso` | rỗng |
| A1–A5 | Agent từ chối | op lạ → `unknown_op`; tham số sai → `invalid_params`; không ký / ký sai → `unauthorized_caller`; UID không có trong allowlist (nobody) bị từ chối ở socket |
| U1 | Update → rollback (cần `--release2`) | `current` trỏ lại bản cũ, health 200 |
| U2 | Uninstall | dịch vụ gỡ, `/home` giữ nguyên, cấu hình chuyển sang `/etc/itso.removed-*` |

## 4. Sau khi chạy

1. Dán bảng trong `build/vm-report.md` vào `docs/reports/phase-4.md` (mục "Kết quả VM"), đổi các dòng "chờ VM".
2. Ghi lệnh và thời gian vào `TEST_REPORT.md`.
3. Dòng FAIL: mở việc sửa trên nhánh mới; **không** sửa script để cho xanh.

## 5. Kiểm thử không cần VM (đã chạy trong CI local)

| Việc | Lệnh |
|---|---|
| Op agent với runner giả (golden argv/file) | `make test-agent` |
| Installer: chữ ký/sha sai, OS sai, không phải root | `make test-installer` |
| Unit systemd | `make units-check` |
| Stack thật với agent thật ở chế độ sandbox | `make dev` (mặc định sandbox) rồi `make test-e2e-real` |
