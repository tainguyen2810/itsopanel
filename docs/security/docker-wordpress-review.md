# Review bảo mật Docker, WordPress, Software (Phase 10, Prompt 10.8)

- **Ngày:** 2026-11-22 · **Phạm vi:** Docker Manager (`app/Domain/Docker/*`, op `docker.*`/`compose.*`, `internal/docker`, `internal/compose`), WordPress Toolkit (`app/Domain/WordPress/*`, op `wp.*`, `ops/wordpress.go`), Software Manager (`app/Domain/Servers/SoftwareService`, op `software.*`, `php.version.*`), website loại `docker`, firewall `scope=docker`, backup volume.
- **Quyết định liên quan:** D-94 → D-100, ADR 0039–0045, threat model `docs/security/threat-model.md`.
- **Cách review:** đọc code theo từng đường vào và đối chiếu với test tự động: Go `ops/docker_test`, `ops/wordpress_test` (restic thật), `compose` (vector + fuzz), Pest `Phase10/*` (agent giả kiểm params/result theo contract), Vitest + Playwright demo, e2e stack thật `e2e-real/phase10.spec.ts` (Engine Docker giả + WP-CLI mô phỏng + restic thật, 4 luồng). Phần cần Docker daemon, iptables, PHP/MariaDB và WordPress thật ghi **chờ VM** (`tests/vm/phase10.sh` V0–V6).

## 1. Ranh giới tin cậy

```text
Trình duyệt ─HTTPS─► Laravel (itso) ──HMAC──► itso-agent (root)
   USER: không có route Docker         │ compose.validate (rule D-96) → validated_yaml + sha256
   SA: bật Docker, override, registry  │ compose.apply chỉ nhận đúng sha256 đã validate
                                       ├─► Engine API (unix socket, chỉ agent) ─► container (no-new-privileges)
                                       │      cổng chỉ 127.0.0.1:20000–29999; DOCKER-USER chặn publish ngoài panel
                                       └─► systemd-run --uid <account> --slice itso-acct-<uid>.slice
                                              php<ver> wp-cli.phar --skip-plugins --skip-themes <allowlist>
```

1. **Docker là đặc quyền root:** chỉ agent nói chuyện với socket; nhóm `docker` luôn rỗng (agent gỡ thành viên khi bật/kiểm); USER không có route nào (Portal không đăng ký `/compose-projects`, `/registries`, `/docker`).
2. **Docker tắt mặc định ở chính sách cục bộ của agent** (`docker: false`): kể cả khi panel bị chiếm, op `docker.*`/`compose.*` trả `op_disabled` cho tới khi root chạy `itso policy set docker on` trên máy chủ.
3. **WordPress chạy code của khách:** mọi lệnh WP-CLI chạy dưới uid account trong slice của account, `NoNewPrivileges`, `PrivateTmp`, giới hạn thời gian; không nạp plugin/theme (`--skip-plugins --skip-themes`), nên plugin độc không chạy trong lúc panel đọc/cập nhật.

## 2. Các mối đe dọa và biện pháp

| # | Tấn công / rủi ro | Biện pháp | Kiểm bằng |
|---|---|---|---|
| D1 | Compose leo thang lên root host (privileged, docker.sock, host network/pid/ipc, cap_add, device, bind mount `/`) | Validator phía agent (D-96) chặn theo rule, chỉ 4 rule override được, override chỉ SUPER_ADMIN kèm lý do ≥ 10 ký tự (lưu audit + revision); `docker.sock`, host pid/ipc, bind ngoài home không override được; `compose.apply` chỉ chạy `validated_yaml` có sha256 khớp | Go `compose` vector độc + fuzz, `ops/docker_test`; Pest `DockerTest` (422, không apply, ADMIN override → 403); e2e (privileged → 422) |
| D2 | Container publish `0.0.0.0` lộ ra Internet | Panel viết lại cổng thành `127.0.0.1:<20000–29999>`; publish ngoài panel bị chuỗi `DOCKER-USER` chặn (chỉ mở cổng có rule `scope=docker`); `userland-proxy=false` | Go (`docker.firewall.sync` iptables-restore), Pest (cấp cổng trong transaction, rule scope=docker), e2e (cổng cấp trong dải); **VM V1** |
| D3 | USER chạm tới Docker | Không có route Portal; quyền `docker.read/write/manage` chỉ realm admin; ADMIN chỉ trên server được giao | Pest (mọi route), e2e (`/portal/...` 404, `/admin/...` từ phiên portal bị từ chối, menu không có Docker) |
| D4 | Lộ credential registry / biến môi trường compose | Mật khẩu registry mã hóa `Crypt`, tới agent bằng tham chiếu `registry_password:<uuid>`; env compose bằng `compose_env:<uuid>`; không nằm trong `job_steps`, audit, response | Pest `DockerTest` (`p8leak`), e2e (danh sách registry không chứa token) |
| D5 | Cập nhật image hỏng làm sập dịch vụ | Agent tag bản cũ `itso-rollback/…`, chờ health; unhealthy/exited → tự quay về, ghi `rolled_back`; giữ N bản rollback | Go `ops/docker_test`; Pest; e2e (Engine giả: bản mới unhealthy → `rolled_back`); **VM V3** |
| D6 | Volume của project này bị project khác/USER đọc | Volume đặt tên `itso_<uuid>_<tên>`, chỉ project đó mount; backup/khôi phục chỉ qua repo server, khôi phục mặc định ra volume mới | Go, Pest (khôi phục `volume:` sai tên → 422), e2e (backup volume); **VM V4** |
| W1 | Plugin/theme độc chạy với quyền panel hoặc root | WP-CLI dưới uid account + slice, `--skip-plugins --skip-themes`, `NoNewPrivileges`; không có lệnh `eval`, `shell`, `package`, `db query`, `plugin install`; cấm cờ `--require/--exec/--ssh/--http/--path/--user/--context/--debug` | Go `TestWPPathGuards` (allowlist, cờ cấm, uid 20001 + slice) |
| W2 | Thoát khỏi thư mục site (symlink, `..`, domain khác) | Đường dẫn chỉ `sites/<domain>/public[/…]` khớp domain của site, lstat từng thành phần, gặp symlink → `path_outside_home`; `wp-config.php` là symlink bị từ chối | Go `TestWPPathGuards` |
| W3 | Lộ mật khẩu admin WordPress / DB | Mật khẩu admin sinh ở panel, trả **một lần** trong `secret` (`Cache-Control: no-store`), giữ tạm trong Cache (Crypt, TTL 2 giờ) dưới tham chiếu `wp_password:<uuid>`, xóa khi job kết thúc; tới WP-CLI chỉ qua stdin `--prompt` | Go (stdin, không có trong argv/audit), Pest `WordPressTest` (không có trong job_steps/job_logs/audit/jobs/notifications, ref bị xóa), e2e (job không chứa secret); **VM V5** |
| W4 | Cập nhật lỗi làm hỏng site | Luôn snapshot restic `pre-wp-update` (file + DB) trước; lỗi update/checksum/HTTP → khôi phục file (giữ bản lỗi `.restore-<ts>`) + DB; khôi phục lỗi → `failed` + thông báo mức cao; không có đích backup hoặc quota backup tạm dừng → từ chối trước khi chạm site | Go `TestWPUpdateFailureRestoresSnapshot` (restic thật), Pest (409 khi chưa có đích, rolled_back/failed + thông báo), e2e (rolled_back với restic thật); **VM V5** |
| W5 | USER thao tác site WordPress của account khác | `WordPressService::scope` theo `Access::accounts`; ngoài phạm vi → 404 ở mọi endpoint; cài chỉ vào website trong phạm vi | Pest `WordPressTest` (7 endpoint → 404, cài vào website người khác → 422, ADMIN ngoài phạm vi → 404) |
| W6 | Staging bị công cụ tìm kiếm lập chỉ mục / lộ dữ liệu | Staging cùng account, tính hạn mức website + DB của gói, mặc định `noindex` (`blog_public=0`); **basic auth chưa có** → API 422, UI tắt kèm lý do | Go `TestWPClone`, Pest (vượt gói → 422, basic_auth → 422), Playwright demo |
| W7 | Hardening bị ghi đè khi áp lại vhost | Cờ vhost (`xmlrpc_blocked`, `php_in_uploads_blocked`) là desired state trong DB panel, `WebsiteSpec::vhost` đọc mỗi lần áp; location chặn đứng trước location PHP | Go `TestVhostWPHardening`, Pest (harden → `nginx.vhost.apply.wp_hardening`); **VM V5** |
| S1 | Kho phần mềm bên thứ ba (PPA ondrej) bị chiếm | Khóa ghim theo fingerprint, chỉ bật khi cài bản PHP cần PPA; wp-cli kiểm sha512 trước khi đặt vào `/usr/local/lib/itso` | Go `ops/software_test` |
| S2 | ADMIN cài/gỡ phần mềm hệ thống | `software.write` chỉ SUPER_ADMIN; gỡ bị chặn khi đang dùng (website dùng PHP, compose project dùng Docker, phụ thuộc), lõi không gỡ được | Pest `SoftwareTest`, e2e (gỡ PHP đang dùng → 409) |

## 3. Giới hạn đã biết (chấp nhận ở Phase 10)

1. **Docker phải bật thêm ở chính sách agent** (`itso policy set docker on`) trên mỗi máy chủ; nếu chưa bật, job "Bật Docker" lỗi `op_disabled` với thông báo rõ. Đây là chủ ý (quyền root không phụ thuộc panel), cần ghi trong runbook vận hành.
2. **Xóa registry không xóa credential đã lưu trên node** (`/etc/itso/docker-client/config.json`, root 0600) cho tới lần đăng nhập/đổi tiếp theo.
3. **`update_available` của image luôn `false`:** panel chưa so digest với registry, người dùng bấm "Cập nhật image" để kiểm.
4. **Kiểm tra registry chạy trên server đầu tiên** có Docker bật.
5. **Staging chưa có basic auth;** chỉ có `noindex`.
6. **Bản lỗi sau khôi phục** (`sites/<domain>.restore-<ts>`) giữ lại để điều tra, chưa dọn tự động (tính vào dung lượng account).
7. **Plugin premium không có trên wordpress.org** không có checksum: bỏ qua, không tính lỗi verify.
8. **Log container realtime** qua gateway hoãn; hiện dùng tail.

Không có phát hiện mức cao còn mở.
