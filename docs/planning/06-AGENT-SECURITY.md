# 06 — Go Agent security model & Threat model

## 1. Nguyên tắc

1. **Agent là ranh giới đặc quyền duy nhất.** Laravel, worker, gateway, frontend không có root, không có sudo, không vào group `docker`.
2. **Không có "run command".** Agent chỉ có danh mục **typed operations** đăng ký sẵn; mỗi op có JSON Schema, validator Go, và executor dùng `exec.Command(path, args...)` với argv cố định — **không bao giờ** qua `sh -c`.
3. **Agent không tin caller.** Coi panel là có thể bị xâm nhập: validate lại mọi tham số, giới hạn mọi đường dẫn, uid, tên dịch vụ.
4. **Hạ quyền sớm nhất.** Thao tác trên dữ liệu của account (file, WP-CLI, git, cron, terminal) chạy trong tiến trình con đã `setresuid/setresgid` về uid của account và nằm trong slice của account.
5. **Chính sách cục bộ thắng panel.** `/etc/itso/agent-policy.yaml` (root:root 0600) quyết định op nguy hiểm nào được phép; chỉ sửa được bằng CLI `itso policy …` với root trên server. Panel bị chiếm vẫn không bật được root terminal.

## 2. Danh mục operation (trích)

| Domain | Op | Mức rủi ro | Mặc định |
|---|---|---|---|
| system | `system.info`, `service.status`, `metrics.snapshot` | Thấp | Bật |
| system | `service.control{name∈allowlist}`, `system.reboot` | Cao | Bật (step-up MFA ở panel) |
| account | `account.ensure`, `account.limits.apply`, `account.suspend`, `account.remove` | Cao | Bật |
| fs | `fs.list/read/write/move/delete/chmod/archive/extract` (as uid) | Trung bình | Bật |
| nginx/php | `nginx.vhost.apply`, `nginx.global.apply`, `php.pool.apply`, `php.version.install` | Cao | Bật |
| db | `db.mysql.*`, `db.pg.*` | Cao | Bật |
| cert | `cert.issue`, `cert.install` | Trung bình | Bật |
| security | `firewall.apply`, `sshd.config.apply`, `fail2ban.apply`, `waf.*`, `malware.*`, `fim.*` | Rất cao | Bật, có safe-apply |
| backup | `backup.run`, `backup.restore`, `backup.check`; `backup.forget` | Cao; forget rất cao | forget **tắt** nếu destination append-only |
| docker | `docker.*`, `compose.*` | Rất cao | **Tắt** đến khi cài module Docker |
| pty | `pty.open{uid≥1000}` | Cao | Bật cho account có SSH |
| pty | `pty.open{uid=0}` (root terminal) | Tối đa | **Tắt** — chỉ bật qua CLI |
| software | `software.install{recipe}` | Cao | Bật (recipe allowlist) |

## 3. Xác thực và truyền thông

| Lớp | Local (v0.1) | Remote (Phase 11) |
|---|---|---|
| Transport | Unix socket `/run/itso/agent.sock` 0660 root:itso-agent-clients | gRPC/HTTP2 qua TLS 1.3, **agent kết nối ra** control plane |
| Danh tính caller | `SO_PEERCRED` (uid ∈ {itso, itso-gw}) + HMAC-SHA256 trên (method, path, body hash, timestamp, nonce) | mTLS: cert client của control plane; agent có cert riêng |
| Danh tính agent | Đường dẫn socket do root tạo | Cert agent cấp qua enrollment token một lần; SPIFFE-like ID `itso://server/<uuid>`; TTL 30 ngày, tự xoay |
| Chống replay | timestamp ±60s + nonce cache | như trên + TLS |
| Ủy quyền | Mỗi request mang `requested_by{user_id, role}` chỉ để audit; quyết định quyền nằm ở panel; agent chỉ thực thi policy cục bộ | như trên |

## 4. Hardening tiến trình agent (systemd)

```ini
[Service]
User=root
NoNewPrivileges=no            # cần để setresuid cho tiến trình con; bù bằng các mục dưới
ProtectHome=no                # cần truy cập /home
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=no       # cần ghi cgroup/slice
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictRealtime=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service @privileged @mount @chown
UMask=0027
```
Agent root thực tế cần quyền rộng (apt, users, nft, nginx, quota) nên hardening chỉ **giảm** bề mặt, không loại bỏ. Phương án tách **agent không đặc quyền + helper đặc quyền nhỏ** được ghi nhận là tối ưu lâu dài (D-13), nhưng tăng độ phức tạp → đánh giá lại ở Phase 12.

## 5. Phòng thủ theo lớp tấn công

| Mối đe dọa | Kịch bản | Biện pháp |
|---|---|---|
| **Command injection** | Domain `a.com;rm -rf /` vào template hoặc argv | Không shell; argv tách biệt; validator regex chặt; template engine escape + reject ký tự `; { } \n \r ' " \` $` trong mọi giá trị Nginx/systemd; golden + fuzz test |
| **Config injection** | Giá trị chèn directive Nginx/PHP-FPM/systemd | Field typed (enum, int range); custom snippet chỉ SA/AD và vẫn qua `nginx -t`; US không có free-text |
| **Path traversal** | `path=../../etc/shadow` | `openat2(dirfd_home, path, RESOLVE_BENEATH\|RESOLVE_NO_MAGICLINKS)` trong tiến trình đã hạ quyền; từ chối path tuyệt đối, NUL |
| **Symlink attack / TOCTOU** | User tạo symlink `public/x → /etc/shadow`, chờ agent (root) đọc/chown | Agent **không bao giờ** thao tác file trong home bằng quyền root; thao tác cần root (chown khi tạo layout) dùng `O_NOFOLLOW`, `fchownat(AT_SYMLINK_NOFOLLOW)` trên fd đã mở; Nginx `disable_symlinks if_not_owner`; `fs.protected_symlinks=1` (mặc định Ubuntu) |
| **Privilege escalation từ website** | Webshell PHP đọc site khác / leo root | PHP-FPM per account (uid riêng); home 0750 + ACL cho www-data chỉ traverse/đọc static; `hidepid=invisible` cho /proc; `disable_functions` mặc định; không setuid trong home (`nosuid` nếu /home riêng phân vùng); OS cập nhật bảo mật tự động |
| **Panel RCE (Laravel bị chiếm)** | Attacker có quyền user `itso` → gọi agent | Agent vẫn chỉ cho typed ops; op nguy hiểm tắt bởi policy cục bộ; không op nào ghi file tùy ý ngoài home/thư mục cấu hình đã định; HMAC key + peercred giới hạn caller; audit cục bộ hash-chain (agent ghi, panel không sửa được); cảnh báo bất thường (tần suất op) |
| **SSRF** | User nhập URL (git repo, webhook, backup S3 endpoint, remote image) để quét mạng nội bộ / metadata cloud | Outbound fetch từ panel qua egress filter: chặn RFC1918, link-local `169.254.0.0/16`, loopback, `::1`, trừ allowlist SA; resolve DNS rồi kiểm tra IP (chống DNS rebinding); timeout & kích thước |
| **CSRF** | Trang độc hại gửi request khi admin đang đăng nhập | Sanctum CSRF token + `SameSite=Strict`; kiểm tra `Origin`; không chấp nhận state-changing GET |
| **XSS** | Tên site/log/tên file chứa script hiển thị trong panel | React escape mặc định; cấm `dangerouslySetInnerHTML` (ESLint rule); CSP nghiêm (`default-src 'self'`, không `unsafe-inline` script); log hiển thị dạng text; file preview HTML không render trong origin panel |
| **Clickjacking** | Nhúng panel trong iframe | `frame-ancestors 'none'` |
| **Brute force** | Đoán mật khẩu panel/SSH/FTP | Rate limit + lockout lũy tiến; Fail2ban jail cho panel log, sshd, pure-ftpd; MFA |
| **Docker privilege** | User có socket → mount `/` → root | Không cấp socket; compose qua validator (cấm `privileged`, `cap_add` nguy hiểm, `pid/network: host`, bind mount ngoài home, `devices`, `/var/run/docker.sock`); `userns-remap` cân nhắc; xem `09-DOCKER.md` |
| **Supply chain** | Package/PPA/image độc hại | Pin version; checksum + chữ ký release ITSO (minisign/cosign); SBOM; `govulncheck`, `composer audit`, `npm audit` trong CI; Dependabot/Renovate |
| **Secret leakage** | Mật khẩu DB, token DNS lộ trong log/backup | Mã hóa cột; redaction trong job params/audit; `.env` 0640; backup cấu hình panel mã hóa bằng restic; không trả secret qua API sau khi tạo |
| **Mất quyền truy cập** | Rule firewall/SSH làm khóa chính admin | Safe-apply: áp dụng → chờ xác nhận heartbeat từ panel trong 60–120s → không có thì tự rollback (timer systemd độc lập) |
| **Lạm dụng tài nguyên** | Fork bomb, crypto miner | Slice: TasksMax, CPUQuota, MemoryMax; monitoring cgroup; malware scan |

## 6. Threat model tóm tắt (STRIDE theo tác nhân)

| Tác nhân | Khả năng ban đầu | Mục tiêu | Biện pháp chính |
|---|---|---|---|
| Internet ẩn danh | HTTP tới site và panel port | Chiếm panel, chiếm site | Panel port + allowlist + entrance path, MFA, WAF, rate limit, cập nhật |
| Website bị hack (webshell) | Code chạy uid account | Đọc site khác, leo root, spam | Isolation uid + slice, /proc hidepid, disable_functions, FIM/malware, egress firewall per-uid (nft `meta skuid`, P1) |
| USER độc hại | Đăng nhập panel/SFTP/SSH của mình | Vượt quota, đọc tài nguyên người khác | Policy + test ma trận quyền, quota kernel, agent validate, chroot SFTP |
| ADMIN bị chiếm | Quyền trong phạm vi | Mở rộng sang phạm vi khác | Scope check mọi query, MFA bắt buộc, audit, không có quyền đổi policy agent |
| Panel bị RCE | uid `itso` | Root | Typed ops, policy cục bộ, HMAC, audit cục bộ |
| Kẻ trộm backup | Truy cập đích lưu | Đọc/xóa dữ liệu | Restic mã hóa; append-only/Object Lock; credential prune tách khỏi panel |
| Insider có root server | Root | — | Ngoài phạm vi bảo vệ; chỉ đảm bảo audit/off-site backup |

## 7. Audit cục bộ của agent
`/var/log/itso/agent-audit.jsonl` (root 0600, `chattr +a` khi hỗ trợ): mỗi dòng `{ts, op, op_id, caller_uid, requested_by, params_hash, result, prev_hash}`. Panel đọc qua op `audit.tail` để đối chiếu với `audit_logs`. Gửi off-host qua backup cấu hình.

## 8. Kiểm thử bảo mật bắt buộc
- Unit/fuzz test cho mọi validator (Go `testing.F`).
- Bộ test "evil inputs" dùng chung giữa PHP và Go (`contracts/test-vectors/*.json`).
- Integration test trên VM: symlink race, zip slip, chroot escape, quota, slice.
- Ma trận quyền API tự động (Pest dataset: endpoint × vai trò × sở hữu).
- Phase 12: pentest nội bộ theo OWASP ASVS L2 + checklist CIS Ubuntu 24.04.
