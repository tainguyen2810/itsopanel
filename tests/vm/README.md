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

## Dữ liệu hosting (Phase 6, Prompt 6.6)

Trong VM đã cài (sau `run-all.sh --release … --no-uninstall`), bằng root:

```bash
bash tests/vm/phase6.sh                 # → /root/itso-vm-phase6.md (--upload-mb 1024 mặc định)
```

| Mã | Kiểm |
|---|---|
| S0 | Cài `mariadb`, `pure-ftpd` qua recipe; 2 account thử (`itsoe`, `itsof`) |
| S1 | Tấn công File Manager dưới uid account trên kernel thật: `../`, đường dẫn tuyệt đối, symlink ra `/etc` và sang account khác, ghi qua thư mục symlink, chmod qua symlink, zip slip + symlink trong archive, hardlink tới `/etc/shadow` |
| S2 | SFTP chroot: `ls /` chỉ thấy home, `cd /etc` lỗi, `cd ../..` không thấy account khác, không có shell |
| S3 | FTPS: FTP thuần bị từ chối, FTPS upload được, file thuộc uid account |
| S4 | Cron: `run_once` chạy đúng uid và trong `itso-acct-<uid>.slice`; unit timer có `Slice=`/`User=` đúng |
| S5 | Upload 1 GB: staging ghi làm 2 lần (ngắt giữa chừng rồi gửi tiếp) → `fs.upload.commit`, sha256 khớp, staging bị xóa |
| S6 | Database: import + export `.sql.gz` dưới uid account; SQL của A thử `DROP`/`CREATE` trên DB của B bị từ chối |
| S7 | Terminal: `pty.open` → socket stream bằng uid `itso-gw` (`lib/term_client.py`) → đúng uid, không đọc `/etc/shadow`, không liệt kê home khác; caller khác bị từ chối |

## Security Center (Phase 7, Prompt 7.7)

Trong VM đã cài (sau `run-all.sh --release … --no-uninstall`), bằng root. Script đổi tường lửa, sshd và
fail2ban thật nên chỉ chạy trong VM dùng một lần; truyền IP máy đang SSH vào để rule chống tự khóa giữ phiên:

```bash
bash tests/vm/phase7.sh --client-ip "${SSH_CLIENT%% *}"   # → /root/itso-vm-phase7.md
```

| Mã | Kiểm |
|---|---|
| S0 | Cài `nginx`, `fail2ban`, `clamav`, `yara`, `modsecurity` qua recipe; `security.audit` thấy đủ gói; account thử `itsog` |
| S1 | Safe-apply: tường lửa (thêm rule) + sshd (`MaxAuthTries 2`) áp dụng không xác nhận, token sai bị từ chối, rồi **dừng itso-agent** (mất kết nối) → timer systemd tự hoàn tác trong 45 giây: ruleset về đúng bản đã xác nhận, `sshd -T` về giá trị cũ, ssh vẫn chạy, `firewall.status` = `rolled_back` |
| S2 | fail2ban chặn thật: SSH user không tồn tại từ IP phụ (dummy `10.250.0.2`) 5 lần → bị ban, kết nối lại bị chặn, `fail2ban.status` có IP, `fail2ban.unban` gỡ được |
| S3 | WAF: site tĩnh + `waf.apply On` → SQLi, XSS, path traversal bị 403, trang thường 200; `DetectionOnly` → 200; `waf.events` gán đúng website (blocked/detected) |
| S4 | EICAR trong 3 000 file: `malware.scan` (clamdscan + yara dưới uid account, slice, Nice 19) tìm thấy; site vẫn 200 suốt lúc quét (ghi load và latency); cách ly → khôi phục đúng chủ |
| S5 | FIM: baseline → thêm file `/usr/local/bin`, sửa `/etc/ssh/sshd_config.d`, xóa file, setuid → `fim.check` báo added/modified/removed/metadata |
| S6 | Điểm bảo mật mặc định sau cài ≥ 80 (`artisan itso:security-audit`, đọc `security_settings`); chưa xong wizard → SKIP |
| S7 | Terminal root: policy tắt → `op_disabled`; `itso policy set terminal.root on` + restart agent → shell uid 0, bản ghi `/var/lib/itso/recordings/<uuid>.cast` 0600 root có output, `pty.recording.read` đọc được; tắt lại → `op_disabled` |

## Docker, WordPress, Software (Phase 10, Prompt 10.8)

Trong VM đã cài (sau `run-all.sh --release … --no-uninstall`), bằng root, cần Internet (Docker Hub, wordpress.org)
và một máy ngoài để thăm dò cổng. Script cài Docker, đổi chuỗi `DOCKER-USER`, chạy registry thử và chặn tạm
`downloads.wordpress.org` trong `/etc/hosts` nên chỉ chạy trong VM dùng một lần:

```bash
sudo bash tests/vm/phase10.sh                              # V0 V2–V6 + chuẩn bị V1 → /root/itso-vm-phase10.md
bash tests/vm/phase10.sh --probe <IP VM> 18080 closed      # trên máy ngoài: cổng publish ngoài panel bị chặn
sudo bash tests/vm/phase10.sh --v1-open                    # mở 18080 trong panel (rule scope=docker)
bash tests/vm/phase10.sh --probe <IP VM> 18080 open        # trên máy ngoài: vào được
sudo bash tests/vm/phase10.sh --cleanup
```

| Mã | Kiểm |
|---|---|
| V0 | `itso policy set docker on` → bật Docker qua panel: recipe docker, `daemon.json` (userland-proxy tắt, no-new-privileges, giới hạn log), nhóm `docker` rỗng, `DOCKER-USER` có rule |
| V1 | Container publish `0.0.0.0:18080` ngoài panel → máy ngoài không vào được; mở trong panel (`scope=docker`) → vào được |
| V2 | Compose thật qua validator (privileged → 422) → cổng `127.0.0.1:20000–29999` → website Docker trả nội dung; HTTPS khi `ITSO_VM_ACME=1` |
| V3 | Registry thử `localhost:5000`: bản mới `HEALTHCHECK false` → `update-images` tự quay về image cũ (`rolled_back`, cùng image id) |
| V4 | Backup volume (pause) → khôi phục ra volume mới → sha256 nội dung giống hệt |
| V5 | WordPress thật: cài qua panel (mật khẩu chỉ trong response), cập nhật akismet khi tải bị chặn → `rolled_back`, file plugin như cũ, site 200; staging 200; harden → `xmlrpc.php` 403, PHP trong uploads 403, `wp-config.php` 0400 |
| V6 | PHP 8.1/8.2/8.4 cài song song, mỗi site trả đúng phiên bản, 3 FPM active |

## Monitoring, Alerts, Notifications (Phase 11, Prompt 11.8)

Trong VM đã cài (sau `run-all.sh --release … --no-uninstall`), bằng root, với scheduler và queue `notifications`
chạy bằng systemd. Script đẩy `/` lên > 90 % bằng `fallocate`, dừng `itso-agent` và `nginx`, thêm dòng vào
`/etc/hosts` và bảng nft tạm, nên chỉ chạy trong VM dùng một lần:

```bash
sudo bash tests/vm/phase11.sh                    # M0–M5 → /root/itso-vm-phase11.md
sudo ITSO_VM_SMTP_HOST=smtp.example.vn ITSO_VM_SMTP_USER=… ITSO_VM_SMTP_PASS=… ITSO_VM_SMTP_TO=ops@example.vn \
  bash tests/vm/phase11.sh                       # thêm M4 (SMTP thật)
sudo bash tests/vm/phase11.sh --cleanup
```

| Mã | Kiểm |
|---|---|
| M0 | RAM/disk server trên panel khớp `/proc/meminfo` và `df` (±10 / ±2 điểm); RAM account đọc từ cgroup v2 thật `itso-acct-<uid>.slice` sau `itso:usage-refresh` |
| M1 | `fallocate` đẩy `/` lên 92 % → "Disk server > 90%" firing ≤ 120 giây (rule kéo dài 60 giây); xóa file → resolved |
| M2 | Dừng `itso-agent` → "Server mất kết nối" firing ≤ 120 giây; bật lại → resolved. Máy node (Phase 9): chặn cổng relay bằng nftables theo runbook |
| M3 | Uptime nginx thật: up → dừng nginx → down sau 3 lần kiểm → bật → up; hạn chứng chỉ khi `ITSO_VM_ACME=1` |
| M4 | Email qua SMTP thật (`ITSO_VM_SMTP_*`), "Gửi thử" → `sent`; không cấu hình → SKIP |
| M5 | Webhook: URL IP riêng không bật cờ → 422; tên miền trỏ IP riêng (qua `/etc/hosts`) → delivery `blocked`, bộ đếm nft 0 gói tin ra IP đó |

## Cập nhật/quay lại + chaos, cài offline (Phase 12, Prompt 12.6)

Trong VM đã cài bản A (`run-all.sh --release A --no-uninstall`), bằng root, với bản B mới hơn:

```bash
bash tests/vm/upgrade-loop.sh --release A --release2 B              # 20 vòng, kill -9 lần lượt ở 6 bước journal → /root/itso-vm-upgrade-loop.md
bash tests/vm/upgrade-loop.sh --release A --release2 B --reboot migrated   # sysrq b giữa cập nhật; VM lên lại thì chạy đúng lệnh này lần nữa
```

| Mã | Kiểm |
|---|---|
| U1–U20 | Mỗi vòng: update → (kill -9 ở bước `downloaded`/`verified`/`extracted`/`migrated`/`switched`/`restarted` → `itso repair --fix`) → version B, doctor + health OK → rollback → version A |
| S1 | Site account (nginx, gọi 5 lần/giây suốt các vòng): **0 lỗi HTTP** |
| P1 | Thời gian panel gián đoạn (tham khảo) |
| R1 | `--reboot <bước>`: sau mất điện, `itso repair --fix` đưa về A hoặc B nhất quán, không còn journal, panel khỏe |

Cài offline: VM **không có mạng** (Multipass `--network` tắt hoặc chặn bằng nftables), chép `itso-<ver>-offline.tar` vào rồi
`sudo bash install.sh --offline itso-<ver>-offline.tar --yes`. Cần lock thật (`scripts/release-offline.sh --update-lock` trên Ubuntu 24.04 có mạng).
