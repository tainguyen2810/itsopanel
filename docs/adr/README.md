# Architecture Decision Records

Mẫu: MADR. Mỗi ADR liên kết mã quyết định trong [DECISIONS.md](../../DECISIONS.md).

| ADR | Tiêu đề | Trạng thái | Quyết định |
|---|---|---|---|
| [0001](0001-ghi-lai-quyet-dinh-kien-truc-bang-adr.md) | Ghi lại quyết định kiến trúc bằng ADR | Accepted | — |
| [0002](0002-monorepo-cho-web-api-agent-contracts.md) | Monorepo cho web, api, agent, contracts | Accepted | D-04 |
| [0003](0003-contracts-first.md) | Contracts-first | Accepted | D-14 |
| [0004](0004-tach-realm-admin-va-portal.md) | Tách realm admin và portal | Accepted | D-25, D-40 |
| [0005](0005-hosting-provisioning-service.md) | Hosting Provisioning Service | Accepted | D-49 |
| [0006](0006-vong-doi-account-va-purge-sau-30-ngay.md) | Vòng đời account và purge sau 30 ngày | Accepted | D-46 |
| [0007](0007-production-gate-truoc-v1-0-0.md) | Production Gate trước v1.0.0 | Accepted | D-47 |
| [0008](0008-chuyen-hosting-account-giua-cac-server.md) | Chuyển Hosting Account giữa các server | Accepted | D-48 |
| [0009](0009-chinh-sach-pentest.md) | Chính sách pentest | Accepted | D-50 |
| [0010](0010-git-local-truoc-github-sau.md) | Git local trước, GitHub sau | Accepted | D-51 |
| [0011](0011-slice-account-va-phien-ssh.md) | Slice cho hosting account và phiên SSH | Accepted | D-12, D-64 |
| [0012](0012-disk-quota.md) | Disk quota cho hosting account | Accepted | D-64 |
| [0013](0013-lop-nen-tang-agent.md) | Lớp nền tảng của agent (Runner, FS, sandbox) | Accepted | D-13, D-63 |
| [0014](0014-vhost-nginx.md) | Vhost Nginx sinh từ template, kiểm `nginx -t` và tự hoàn tác | Accepted | D-67 |
| [0015](0015-php-fpm-per-account.md) | PHP-FPM master riêng cho từng account, pool theo website | Accepted | D-68, D-12 |
| [0016](0016-acme-lego.md) | Chứng chỉ ACME bằng lego, gia hạn, chứng chỉ tải lên | Accepted | D-69 |
| [0017](0017-dns-cloudflare.md) | DNS qua Cloudflare API từ Laravel | Accepted | D-70 |
| [0018](0018-database-hosting.md) | Database hosting (MariaDB + PostgreSQL), danh tính chủ theo account | Accepted | D-71 |
| [0019](0019-file-manager-ha-quyen.md) | File Manager chạy dưới uid account, openat2, nén/giải nén an toàn | Accepted | D-72 |
| [0020](0020-sftp-ftps-ssh-key.md) | SFTP (OpenSSH chroot), FTPS phụ (Pure-FTPd), SSH key | Accepted | D-73 |
| [0021](0021-cron-systemd-timer.md) | Cron bằng systemd timer trong slice của account | Accepted | D-74 |
| [0022](0022-terminal-user-jail.md) | Terminal cho USER chạy trong jail qua itso-gateway | Accepted | D-75 |
| [0023](0023-firewall-nftables-safe-apply.md) | Tường lửa nftables, bảng riêng, safe-apply có hoàn tác | Accepted | D-76 |
| [0024](0024-ssh-hardening-fail2ban.md) | SSH hardening (safe-apply) và Fail2ban | Accepted | D-77 |
| [0025](0025-waf-modsecurity-crs.md) | WAF ModSecurity v3 + OWASP CRS theo website | Accepted | D-78 |
| [0026](0026-malware-quarantine.md) | Quét mã độc dưới uid account và khu cách ly | Accepted | D-79 |
| [0027](0027-fim-security-score.md) | FIM trong agent, điểm bảo mật và sự kiện | Accepted | D-80 |
| [0028](0028-portal-protection-terminal-root.md) | Bảo vệ đăng nhập, allowlist không tự khóa, Terminal root theo policy | Accepted | D-81 |
| [0029](0029-backup-repos-restic.md) | Repo restic riêng theo account × đích, bộ khôi phục một lần | Accepted | D-82 |
| [0030](0030-backup-destinations-immutable.md) | Đích local/SFTP/S3/rest, credential chỉ ghi, forget tắt mặc định | Accepted | D-83 |
| [0031](0031-backup-content-consistency.md) | Nội dung backup, dump DB nhất quán, backup panel mã hóa age | Accepted | D-84 |
| [0032](0032-restore-staging.md) | Khôi phục qua staging root rồi helper uid account | Accepted | D-85 |
| [0033](0033-backup-verify-dr.md) | Lịch, quota, kiểm chứng 3-2-1-1-0, khôi phục thảm họa | Accepted | D-86, D-87 |
| [0034](0034-roles-topology.md) | Vai trò cài đặt all-in-one / control-plane / node | Accepted | D-88 |
| [0035](0035-agent-relay-mtls.md) | itso-relay mTLS, node kết nối ra, khóa HMAC mỗi server | Accepted | D-89 |
| [0036](0036-internal-ca.md) | CA nội bộ, chứng chỉ node 30 ngày, token join | Accepted | D-90 |
| [0037](0037-jobs-offline-placement.md) | Job chờ node, trạng thái kết nối, gợi ý server | Accepted | D-91, D-92 |
| [0038](0038-account-migration.md) | Chuyển account qua repo restic, giữ nguồn, dọn dẹp | Accepted | D-93 |
| [0039](0039-docker-engine.md) | Cài Docker từ Ubuntu, daemon.json, Engine API qua socket | Accepted | D-94 |
| [0040](0040-docker-firewall.md) | Chain DOCKER-USER, Docker không vượt tường lửa | Accepted | D-95 |
| [0041](0041-compose-validator.md) | Validator compose, override của Super Admin, revision | Accepted | D-96 |
| [0042](0042-docker-ports-sites.md) | Dải cổng 20000–29999, website loại docker | Accepted | D-97 |
| [0043](0043-docker-images-volumes.md) | Cập nhật image có rollback, registry, backup volume | Accepted | D-98 |
| [0044](0044-wordpress-toolkit.md) | WordPress Toolkit (WP-CLI dưới UID account, cập nhật an toàn) | Accepted | D-99 |
| [0045](0045-software-manager.md) | Software Manager (catalog, PPA ghim khóa, unattended-upgrades) | Accepted | D-100 |

Các quyết định kỹ thuật còn Proposed (D-01, D-02, D-03, D-06–D-13, …) sẽ có ADR khi được duyệt hoặc khi Phase tương ứng bắt đầu.
