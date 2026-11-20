# 09 — Docker Manager (module tùy chọn)

## 1. Nguyên tắc
- Docker **không cài mặc định**. Cài qua Software Manager → bật op `docker.*` trong policy agent.
- Chỉ **agent** truy cập `/var/run/docker.sock`. Không user nào (kể cả `itso`) trong group `docker`.
- USER không bao giờ có socket. Quyền Docker của gói = được dùng **managed compose** đã qua validator (Phase 9b, sau khi phần admin ổn định).

## 2. Chức năng
| Nhóm | Chức năng |
|---|---|
| Containers | List, inspect, start/stop/restart/remove, logs (stream qua gateway), stats, exec terminal (SA/AD, qua gateway, có audit) |
| Compose Projects | Tạo từ YAML hoặc template (WordPress, Uptime Kuma, n8n, MinIO…), lưu revision, validate, up/down/pull/recreate, diff giữa revision |
| Images | List, pull (từ registry đã cấu hình), prune, kiểm tra bản mới (so digest), cập nhật có rollback (giữ image cũ) |
| Volumes / Networks | List, tạo, xóa (chặn nếu đang dùng), dung lượng volume |
| Registries | Lưu credential mã hóa; login khi pull |
| Resource limits | `cpus`, `mem_limit`, `pids_limit` bắt buộc; `cgroup_parent` = slice của account (cho managed apps) |
| Reverse proxy + SSL | Website loại `docker`: Nginx `proxy_pass http://127.0.0.1:<port>` + cert ACME như site thường |
| Backup/Restore | Volume backup theo `08-BACKUP.md` §3 |

## 3. Validator compose (cho mọi project, chặt hơn cho USER)
Từ chối nếu có: `privileged: true`; `cap_add` ngoài allowlist (`NET_BIND_SERVICE`, `CHOWN`, `SETUID`, `SETGID`); `network_mode: host`, `pid: host`, `ipc: host`, `userns_mode: host`; `devices`; `security_opt` tắt apparmor/seccomp; bind mount tới `/`, `/etc`, `/var/run/docker.sock`, `/proc`, `/sys`, hoặc ngoài `/home/<acct>/apps/` (với USER); `ports` bind vào `0.0.0.0` (tự viết lại thành `127.0.0.1`); thiếu giới hạn tài nguyên (tự thêm theo gói). SA có thể override từng rule với cảnh báo + audit.

Validator viết bằng Go trong agent (nguồn sự thật), Laravel gọi `compose.validate` để hiển thị lỗi sớm.

## 4. Xung đột cổng Docker ↔ Nginx
- Port 80/443 **thuộc Nginx**. Container không bao giờ publish 80/443 trên host.
- Port publish được cấp từ dải `20000–29999` do panel quản lý (bảng `port_allocations(server_id, port, owner_type, owner_id)` unique) → không trùng nhau, không trùng service khác (agent kiểm tra `ss -ltn` trước khi cấp).
- Mặc định bind `127.0.0.1:<port>` và expose ra ngoài qua Nginx reverse proxy + SSL.

## 5. Docker không được phá firewall
Vấn đề: Docker chèn rule iptables/nftables (chain `DOCKER`, NAT) trước rule của UFW/nft của panel → port publish trên `0.0.0.0` lộ ra Internet dù firewall "chặn".
Biện pháp (kết hợp):
1. `daemon.json`: `"ip": "127.0.0.1"` (mặc định publish chỉ loopback), `"iptables": true` (giữ để NAT hoạt động), `"userland-proxy": false`, `"live-restore": true`, `"log-opts": {"max-size":"10m","max-file":"3"}`.
2. Rule trong chain **`DOCKER-USER`** (Docker luôn đi qua chain này trước): mặc định DROP traffic từ interface public tới container, chỉ ACCEPT các port SA mở rõ ràng trong panel → agent đồng bộ `DOCKER-USER` từ `firewall_rules`.
3. Bảng nft `inet itso` của panel không đụng vào bảng của Docker; `firewall.apply` không flush toàn bộ ruleset (chỉ bảng của mình) để không xóa rule Docker.
4. Test bắt buộc: publish `0.0.0.0:8080` thử → từ máy ngoài không truy cập được trừ khi mở trong panel.
5. Theo dõi: Docker Engine 29+ có backend nftables thử nghiệm — đánh giá lại khi ổn định.

## 6. Rootless / cô lập mạnh hơn (tương lai)
- `userns-remap` toàn daemon: giảm rủi ro container escape, nhưng phức tạp quyền volume → đánh giá ở Phase 12.
- Rootless Docker/Podman per account: cô lập tốt nhất cho USER, tốn tài nguyên; ghi nhận làm phương án cho USER Docker nếu nhu cầu thật sự lớn.

## 7. Phân quyền
| Vai trò | Quyền |
|---|---|
| SA | Toàn bộ, override validator có audit |
| AD | Trên server được giao; không override validator |
| US (gói có docker_permission) | Chỉ compose từ template/YAML đã validate trong account; xem log/restart container của mình; không exec root, không thấy container người khác |
