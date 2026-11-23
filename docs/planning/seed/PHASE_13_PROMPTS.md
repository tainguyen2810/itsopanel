# Phase 13 — Kiểm thử trên VPS thật và phát hành v1.0.0: prompt chi tiết

> Viết ngày 2026-11-23, sau khi Phase 12 được duyệt (merge `234729d`, tag local `v1.0.0-rc.1`, ghi nhận duyệt `190ecab`). Người dùng chọn hướng "Phase 13: kiểm thử VM → v1.0.0" và hỏi cấu hình VPS. Nguồn: `ROADMAP.md` §Production Gate, `DECISIONS.md` D-47 (Gate G1–G8 có bằng chứng), D-50 (pentest độc lập trước khi mở cho khách ngoài), D-115 (`v1.0.0` chỉ khi Gate đạt trên VM), `docs/gate/`, `tests/vm/`.
> Nhánh `phase-13`. Làm hàng loạt 13.0 → 13.7, tự merge, DỪNG cuối Phase 13. Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED.
> Không có màn hình mới nên không có prompt mockup. Nếu phải sửa giao diện vì lỗi tìm ra trên VPS thì chụp lại ảnh liên quan.
> **Điều kiện bắt đầu:** người dùng đã cấp VPS (IP) và đặt SSH key; máy Windows của người dùng bật Remote Control.

## Mục tiêu

1. Chạy mọi bộ test "chờ VM" của Phase 4 → 12 trên Ubuntu 24.04 thật, ghi kết quả thật vào báo cáo của từng Phase và `TEST_REPORT.md`.
2. Chạy đủ Production Gate G1–G8, lưu bằng chứng ở `docs/gate/G<n>.md`, ghi trạng thái bằng `itso:gate-record`.
3. Sửa mọi lỗi tìm ra (có test hồi quy trong repo), chạy lại bài liên quan.
4. Hoàn thiện phần phát hành còn tạm: lock `.deb` thật cho bản offline, khóa ký release thật (ngoài repo).
5. Phát hành `v1.0.0` khi cả 8 bài Gate `pass` và không còn lỗi High/Critical mở. Nếu chưa đạt thì phát hành `v1.0.0-rc.2` và ghi rõ bài nào chưa đạt.

## Hạ tầng test (người dùng cấp)

| Máy | Vai trò | Tối thiểu |
|---|---|---|
| VPS 1 | Panel + server chính (all-in-one) | 4 vCPU, 8 GB RAM, 80 GB SSD |
| VPS 2 | Server thứ hai (`--role node`): G1 trên 2 server, G4 khôi phục khác server, G6 đích DR, G7 chuyển account | 2 vCPU, 4 GB RAM, 40 GB SSD |
| Đích backup bất biến | G4 "panel không xóa được backup immutable" | Bucket S3 có Object Lock, hoặc VPS 3 (2 vCPU, 2 GB, 100 GB) chạy MinIO có object lock |

Mức tiết kiệm vẫn chạy được (bài nặng chậm hơn): VPS 1 2 vCPU/4 GB/40 GB, VPS 2 1–2 vCPU/2 GB/20 GB. Đây là cấu hình cho **bộ test**; panel tự nó cần tối thiểu 1 vCPU/1 GB/10 GB, khuyến nghị 2 vCPU/2 GB/20 GB (preflight installer).

Chung: Ubuntu 24.04 LTS sạch, ảo hóa KVM, kernel generic (có quota v2, cgroup v2, nftables), IPv4 public, root qua SSH key, cổng 22/80/443. Chỉ dùng để test, không chứa dữ liệu thật; có snapshot càng tốt. Tùy chọn: subdomain test trỏ về VPS 1 (ACME thật), SMTP test (M4 Phase 11).

## Cách điều khiển

- Môi trường cloud không mở được kết nối ra cổng 22 (đã thử 2026-11-23: connection refused). Điều khiển VPS qua **phiên Remote Control trên máy Windows của người dùng**, dùng OpenSSH của Windows với key `~\.ssh\itso_vps` (người dùng tự tạo, private key không rời máy đó).
- Bản phát hành build ở cloud (`make release`), đẩy lên nhánh `phase-13` trên GitHub; phiên Remote Control kéo về (hoặc tải artifact) rồi `scp` lên VPS. Bộ test chạy trên VPS bằng root, kết quả (bảng Markdown) lấy về và commit.
- Không bao giờ đưa mật khẩu, private key hay secret của VPS vào repo, chat, params job hoặc báo cáo. Báo cáo chỉ ghi IP dạng che (`vps1`, `vps2`).

## Ràng buộc

- Các VPS này là **VM test dùng một lần** theo nghĩa của CLAUDE.md ("Phase 4+ chỉ trên VM test"). Không chạy bộ test trên máy chủ thật nào khác.
- Bài phá hủy (reboot đột ngột, kill -9, gỡ panel, thử leo quyền) chỉ chạy trên VPS test. G8 gỡ cài đặt chạy cuối cùng.
- Không skip hay disable test để cho xanh. Bài không chạy được vì thiếu hạ tầng ghi `partial`/`pending_vm` kèm lý do.
- Laravel không chạy lệnh hệ thống; agent không có op chạy lệnh tùy ý; contract trước code (nếu sửa lỗi cần đổi API/op).

## Danh sách prompt

| Prompt | Việc |
|---|---|
| 13.0 | Kết nối và kiểm điều kiện VPS |
| 13.1 | Cài sạch + bộ Phase 4 trên VPS 1 và VPS 2 |
| 13.2 | Bộ Phase 5–7 (website, dữ liệu hosting, bảo mật) |
| 13.3 | Bộ Phase 8–9 (backup, DR, nhiều server, chuyển account) |
| 13.4 | Bộ Phase 10–11 (Docker, WordPress, software, monitoring) |
| 13.5 | Vòng cập nhật 20 lần + chaos, bản offline thật |
| 13.6 | Production Gate G1–G8 |
| 13.7 | Khóa ký thật, phát hành, báo cáo, merge |

## Prompt 13.0 — Kết nối và kiểm điều kiện

- Mở Remote Control trên máy người dùng; `ssh` thử từng VPS; ghi `known_hosts` (đối chiếu fingerprint với người dùng nếu nhà cung cấp hiển thị).
- Script mới `tests/vm/preflight-remote.sh` (chỉ đọc): phiên bản Ubuntu, kernel, `systemd-detect-virt` = `kvm`, cgroup v2, module quota, nftables, RAM/disk, giờ hệ thống, DNS ra ngoài. Lưu kết quả vào `docs/reports/phase-13.md` (che IP).
- Chụp snapshot "sạch" nếu nhà cung cấp hỗ trợ (người dùng bấm hoặc cấp API).

## Prompt 13.1 — Cài sạch + Phase 4

- `make release` (bản `1.0.0-rc.2-dev` để test), chép lên VPS. `tests/vm/run-all.sh --release … --no-uninstall` trên VPS 1 (R1: cài ≤ 10 phút, doctor, HTTPS health, enforcement E1–E8, agent từ chối, update → rollback). VPS 2 cài `--role node` và enroll vào VPS 1.
- Đo RAM/CPU thực tế của panel lúc rảnh và lúc có 20 site (ghi vào báo cáo, cập nhật yêu cầu phần cứng trong tài liệu cài đặt nếu khác preflight).
- `systemd-analyze security` thật cho unit agent (mục tiêu ≤ 5.0, ADR 0056).
- Ghi kết quả vào `docs/reports/phase-4.md` (mục VM) và `TEST_REPORT.md`.

## Prompt 13.2 — Phase 5–7

- `tests/vm/phase5.sh` (Pebble + HTTP-01 thật qua Nginx; nếu có subdomain thì thử thêm Let's Encrypt staging), `phase6.sh` (File Manager trên kernel thật, SFTP chroot, FTPS, cron trong slice, upload 1 GB, DB), `phase7.sh` (firewall/SSH tự rollback, WAF, fail2ban, quét malware).
- Lỗi tìm ra: sửa, test hồi quy, chạy lại đúng mục lỗi.

## Prompt 13.3 — Phase 8–9

- `phase8.sh` với đích backup bất biến thật (S3 Object Lock hoặc MinIO): backup ≥ 2 đích, restore, panel không xóa được bản immutable, `--dr-target` dựng lại control plane trên VPS 2, đo RTO/RPO.
- `phase9.sh --panel-2`: enroll, chuyển ≥ 5 account VPS 1 → VPS 2 và ngược lại, cutover + rollback, khôi phục chéo server (dùng cho G4, G6, G7).

## Prompt 13.4 — Phase 10–11

- `phase10.sh` (Docker Engine thật, DOCKER-USER, WordPress cập nhật có snapshot + tự khôi phục, software nhiều bản PHP).
- `phase11.sh` M0–M5 (cgroup v2 thật, cảnh báo disk/mất kết nối ≤ 2 phút, uptime; M4 SMTP nếu người dùng cấp).

## Prompt 13.5 — Cập nhật lặp + chaos, offline thật

- `tests/vm/upgrade-loop.sh` 20 vòng + kill -9 ở 6 bước journal + `--reboot <bước>` (mất điện thật bằng sysrq); site account 0 lỗi HTTP.
- `scripts/release-offline.sh --update-lock` trên VPS (Ubuntu 24.04 có mạng) → commit `packaging/offline-packages.lock` thật; cài offline trên VPS đã chặn mạng ra (nftables), hoặc dựng lại từ snapshot.

## Prompt 13.6 — Production Gate G1–G8

- `tests/vm/gate.sh --release A --release2 B --release3 C --node-report … --g4-report … --g6-report … --g7-report … --record`, G8 (`--allow-uninstall`) chạy cuối.
- G4: 10 lần khôi phục ngẫu nhiên, ≥ 1 lần sang VPS 2. G5: 3 bản phát hành liên tiếp (build 3 phiên bản test từ cùng mã với số khác nhau), rollback giữa chừng.
- Cập nhật `docs/gate/G1–G8.md` với lệnh, log rút gọn, kết quả, thời điểm; trang Sẵn sàng production phải hiện đúng trạng thái đã ghi.

## Prompt 13.7 — Phát hành

- Khóa ký release thật: người dùng tạo trên máy mình theo `docs/security/update-policy.md` §3, chỉ đưa public key vào repo; ký release trên máy người dùng qua Remote Control (private key không lên cloud).
- Nếu G1–G8 đều `pass` và không còn High/Critical mở: `v1.0.0` (release notes, tag local, `make release` + `release-offline`). Nếu chưa: `v1.0.0-rc.2`, ghi rõ bài còn thiếu.
- `docs/reports/phase-13.md`, `PHASE_STATUS.md`, `TEST_REPORT.md`, `make check`, merge `--no-ff`, đẩy `main` và `phase-13`, DỪNG chờ duyệt.

## Tiêu chí nghiệm thu

| Tiêu chí | Đo bằng |
|---|---|
| Mọi bộ test VM Phase 4–12 đã chạy trên Ubuntu 24.04 thật, kết quả ghi lại | báo cáo từng Phase + `TEST_REPORT.md` |
| Gate G1–G8 có bằng chứng, trạng thái ghi trong panel | `docs/gate/G<n>.md`, trang Sẵn sàng production |
| Update/rollback 20 lần liên tiếp + chaos thành công | báo cáo `upgrade-loop.sh` |
| Bản offline cài được không cần Internet | log cài trên VPS chặn mạng |
| Không còn High/Critical mở | `docs/security/` + danh sách lỗi Phase 13 |

## Rủi ro

- Nhà cung cấp VPS dùng kernel `-kvm` thiếu module quota → E4/G2 chỉ đo được một phần; cần kernel generic.
- Remote Control phụ thuộc máy Windows bật và mạng ổn định; bài dài (upgrade loop, G5) nên chạy trong `tmux`/`nohup` trên VPS để không đứt khi mất kết nối.
- Pentest độc lập (D-50) vẫn là việc riêng, bắt buộc trước khi mở cho khách bên ngoài; Phase 13 không thay thế được.
