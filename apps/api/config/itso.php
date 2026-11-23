<?php

use App\Domain\Backup\BackupJobHandler;
use App\Domain\Data\DataJobHandler;
use App\Domain\Dns\DnsRecordsStep;
use App\Domain\Docker\DockerJobHandler;
use App\Domain\Hosting\AccountJobHandler;
use App\Domain\Imports\ImportJobHandler;
use App\Domain\Imports\ImportService;
use App\Domain\Migration\MigrationJobHandler;
use App\Domain\Migration\MigrationService;
use App\Domain\Security\CisJobHandler;
use App\Domain\Security\FirewallApplyStep;
use App\Domain\Security\FirewallConfirmStep;
use App\Domain\Security\SecurityJobHandler;
use App\Domain\Security\SshdApplyStep;
use App\Domain\Security\SshdConfirmStep;
use App\Domain\Servers\SoftwareJobHandler;
use App\Domain\Web\CertificateJobHandler;
use App\Domain\Web\ServerWebJobHandler;
use App\Domain\Web\WebsiteJobHandler;
use App\Domain\WordPress\WordPressJobHandler;
use App\Domain\WordPress\WordPressService;

return [
    // Phiên bản panel; commit được truyền qua biến môi trường lúc build (không gọi git từ PHP).
    'version' => env('ITSO_VERSION', '0.5.0-beta'),
    'commit' => env('ITSO_COMMIT', 'dev'),
    'agent_min_version' => '0.1.0',
    // Kênh cập nhật hiển thị ở /system/updates (panel không tự cập nhật; root chạy `itso update`).
    'update_channel' => env('ITSO_UPDATE_CHANNEL', 'stable'),
    // Thư mục release do installer quản lý (chỉ đọc tên thư mục để liệt kê phiên bản).
    'releases_dir' => env('ITSO_RELEASES_DIR', '/opt/itso/releases'),
    'current_link' => env('ITSO_CURRENT_LINK', '/opt/itso/current'),
    // Body tối đa của API JSON (KB, ASVS L2 — Prompt 12.4); chunk upload File Manager có giới hạn riêng.
    'max_body_kb' => (int) env('ITSO_MAX_BODY_KB', 2048),
    // Journal + lịch sử cập nhật do agent ghi (D-113); panel chỉ đọc.
    'update_state_dir' => env('ITSO_UPDATE_STATE_DIR', '/var/lib/itso'),
    // Wizard bước 0: file băm mã thiết lập do `itso setup-code` ghi (/var/lib/itso/setup-code.json).
    'setup_code_file' => env('ITSO_SETUP_CODE_FILE', '/var/lib/itso/setup-code.json'),

    'agent' => [
        // Linux: unix socket. Windows dev: ITSO_AGENT_URL=http://127.0.0.1:7810.
        'socket' => env('ITSO_AGENT_SOCKET', '/tmp/itso-mock-agent.sock'),
        'url' => env('ITSO_AGENT_URL'),
        'timeout' => (float) env('ITSO_AGENT_TIMEOUT', 5),
        // Khóa HMAC dùng chung với agent thật (D-66). Trống = không ký (mock agent dev).
        'key_file' => env('ITSO_AGENT_KEY_FILE'),
        // Agent coi là "đang kết nối" nếu lần liên lạc cuối trong khoảng này (giây).
        'connected_window_sec' => (int) env('ITSO_AGENT_CONNECTED_WINDOW', 300),
    ],

    // Kênh node từ xa qua itso-relay (Phase 9, D-89/D-91): heartbeat 20 giây.
    // CA nội bộ (D-90): Laravel chỉ đọc chứng chỉ công khai để in pin; khóa CA chỉ agent local đọc.
    // Vai trò cài đặt do `itso install --role` ghi (D-88); server local lấy node_role từ đây.
    'node_identity_file' => env('ITSO_NODE_IDENTITY_FILE', '/etc/itso/node.json'),

    'pki' => [
        'ca_file' => env('ITSO_PKI_CA_FILE', '/etc/itso/pki/ca.pem'),
        // URL tải install.sh in trong lệnh join (trống = chỉ in `sudo bash install.sh …`).
        'install_url' => env('ITSO_INSTALL_URL'),
    ],

    // SSE sự kiện job (D-106, ADR 0051): giữ tối đa 5 phút, heartbeat 15 giây, đọc log mới mỗi giây.
    'sse' => [
        'max_sec' => (int) env('ITSO_SSE_MAX_SEC', 300),
        'heartbeat_sec' => 15,
        'poll_ms' => (int) env('ITSO_SSE_POLL_MS', 1000),
    ],
    'relay' => [
        // Unix socket của itso-relay (Laravel gửi envelope cho node mtls qua đây).
        'socket' => env('ITSO_RELAY_SOCKET', '/run/itso-relay/relay.sock'),
        // URL node quay số tới (in trong lệnh join). Trống = https://<host của panel>:28444.
        'public_url' => env('ITSO_RELAY_PUBLIC_URL'),
        // Job tới node mất kết nối chờ tối đa (D-91): op ghi 30 phút, op đọc 2 phút.
        'wait_write_sec' => (int) env('ITSO_RELAY_WAIT_WRITE', 1800),
        'wait_read_sec' => (int) env('ITSO_RELAY_WAIT_READ', 120),
        // Khóa ký yêu cầu enroll mà relay chuyển tiếp (dùng chung với itso-relay --relay-key-file).
        'enroll_key_file' => env('ITSO_RELAY_ENROLL_KEY_FILE', '/etc/itso/relay/enroll.key'),
        'degraded_after_sec' => (int) env('ITSO_RELAY_DEGRADED_AFTER', 60),
        'unreachable_after_sec' => (int) env('ITSO_RELAY_UNREACHABLE_AFTER', 300),
    ],

    // Hook theo loại job (App\Domain\Jobs\JobHandler): cập nhật observed state khi job kết thúc.
    'job_handlers' => array_fill_keys([
        'hosting_account.create', 'hosting_account.suspend', 'hosting_account.unsuspend', 'hosting_account.restore',
        'hosting_account.terminate', 'hosting_account.change_package', 'hosting_account.update', 'hosting_account.reconcile',
        'package.migrate_accounts',
    ], AccountJobHandler::class) + [
        'software.install' => SoftwareJobHandler::class,
        'software.remove' => SoftwareJobHandler::class,
        'software.upgrade' => SoftwareJobHandler::class,
        'software.os_updates' => SoftwareJobHandler::class,
    ] + array_fill_keys(['website.create', 'website.update', 'website.nginx.update', 'website.php.update',
        'website.domain.add', 'website.domain.remove', 'website.delete'], WebsiteJobHandler::class)
      + array_fill_keys(['php.version.install', 'php.version.remove', 'php.extensions.install', 'setup.stack'],
          ServerWebJobHandler::class)
      + array_fill_keys(['certificate.issue', 'certificate.upload', 'certificate.renew', 'certificate.delete'],
          CertificateJobHandler::class)
      + array_fill_keys(DataJobHandler::TYPES, DataJobHandler::class)
      + array_fill_keys(SecurityJobHandler::TYPES, SecurityJobHandler::class)
      + array_fill_keys(BackupJobHandler::TYPES, BackupJobHandler::class)
      + array_fill_keys(MigrationService::TYPES, MigrationJobHandler::class)
      + array_fill_keys(DockerJobHandler::TYPES, DockerJobHandler::class)
      + array_fill_keys(WordPressService::TYPES, WordPressJobHandler::class)
      + array_fill_keys(ImportService::TYPES, ImportJobHandler::class)
      + ['cis.audit' => CisJobHandler::class],

    // Docker (Phase 10, D-94…D-98): giao diện mạng công khai cho DOCKER-USER; giới hạn mặc định chèn vào service
    // compose thiếu limit; số bản rollback image giữ lại mỗi service.
    'docker' => [
        'public_interface' => env('ITSO_DOCKER_PUBLIC_IFACE', 'eth0'),
        'default_mem_limit_mb' => (int) env('ITSO_DOCKER_DEFAULT_MEM_MB', 512),
        'default_cpus' => (float) env('ITSO_DOCKER_DEFAULT_CPUS', 1.0),
        'default_pids_limit' => (int) env('ITSO_DOCKER_DEFAULT_PIDS', 512),
        'keep_rollbacks' => 2,
        'health_timeout_sec' => 60,
    ],

    // Bước job chạy trong panel (không qua agent): op → lớp PanelStep.
    'panel_steps' => [
        'dns.records.apply' => DnsRecordsStep::class,
        // Safe-apply (D-76/D-77): token xác nhận không đi qua job_steps.
        'firewall.apply' => FirewallApplyStep::class,
        'firewall.confirm' => FirewallConfirmStep::class,
        'sshd.config.apply' => SshdApplyStep::class,
        'sshd.config.confirm' => SshdConfirmStep::class,
    ],

    // File Manager (D-72): thư mục staging upload (panel ghi chunk, agent đọc khi commit), giới hạn giải nén.
    // Terminal USER (D-75): URL WebSocket của itso-gateway; rỗng = suy từ host của request (/gateway/terminal).
    'gateway' => [
        'ws_url' => env('ITSO_GATEWAY_WS_URL'),
    ],

    // Security Center (Phase 7, D-76…D-81). Cổng panel dùng cho bất biến chống tự khóa nếu wizard chưa lưu;
    // auth_log: Laravel ghi một dòng cho mỗi lần đăng nhập sai (chỉ IP) để jail fail2ban `itso-panel` đọc.
    'security' => [
        'panel_port' => (int) env('ITSO_PANEL_PORT', 8443),
        'ssh_admin_user' => env('ITSO_SSH_ADMIN_USER', 'root'),
        'auth_log' => env('ITSO_AUTH_LOG', '/var/log/itso/auth.log'),
        'scan_max_file_mb' => (int) env('ITSO_SCAN_MAX_FILE_MB', 64),
        'captcha_difficulty' => (int) env('ITSO_CAPTCHA_DIFFICULTY', 16),
    ],

    'files' => [
        'upload_dir' => env('ITSO_UPLOAD_DIR', '/var/lib/itso/uploads'),
        'extract_max_bytes' => (int) env('ITSO_EXTRACT_MAX_BYTES', 4 * 1024 * 1024 * 1024),
    ],

    // ACME (D-69): email nhận thông báo của CA và directory (allowlist; Pebble chỉ cho test/CI).
    'acme' => [
        'email' => env('ITSO_ACME_EMAIL'),
        'directory' => env('ITSO_ACME_DIRECTORY', 'letsencrypt'),
        'allow_pebble' => (bool) env('ITSO_ACME_ALLOW_PEBBLE', false),
        'renew_before_days' => 30,
    ],

    // DNS Cloudflare (D-70): base URL cố định, không nhận URL từ người dùng.
    'cloudflare' => [
        'base_url' => 'https://api.cloudflare.com/client/v4',
        'timeout' => 10,
    ],

    // Server local (Phase 3: một server, agent local/mock). `itso:server-local` tạo/cập nhật bản ghi này.
    'local_server' => [
        'enabled' => (bool) env('ITSO_LOCAL_SERVER', true),
        'name' => env('ITSO_LOCAL_SERVER_NAME') ?: 'srv-local',
        'hostname' => env('ITSO_LOCAL_SERVER_HOSTNAME') ?: 'localhost',
        'role_tags' => ['web', 'db'],
    ],

    // Xác thực (D-58). Realm của /api/v1/auth/*: theo host nếu khớp, ngược lại theo header X-ITSO-Realm.
    'auth' => [
        'hosts' => [
            'admin' => env('ITSO_ADMIN_HOST'),
            'portal' => env('ITSO_PORTAL_HOST'),
        ],
        // URL giao diện từng realm (link đặt lại mật khẩu trong email).
        'app_urls' => [
            'admin' => env('ITSO_ADMIN_URL') ?: rtrim((string) env('APP_URL', 'http://localhost'), '/').'/admin',
            'portal' => env('ITSO_PORTAL_URL') ?: rtrim((string) env('APP_URL', 'http://localhost'), '/').'/portal',
        ],
        // Khóa lũy tiến: từ lần sai thứ `threshold` khóa 1, 2, 4… phút (tối đa `max_lock_minutes`).
        'lockout' => [
            'threshold' => (int) env('ITSO_LOGIN_LOCK_THRESHOLD', 5),
            'ip_threshold' => (int) env('ITSO_LOGIN_IP_THRESHOLD', 20),
            'window_minutes' => 60,
            'max_lock_minutes' => 60,
        ],
        'mfa_issuer' => env('ITSO_MFA_ISSUER', 'ITSO'),
        'recovery_codes' => 10,
        'step_up_seconds' => 600,
        'password_reset_minutes' => 60,
        'invite_hours' => 72,
        // Giả danh (D-61): vé đổi phiên 60 giây, phiên giả danh 30 phút.
        'impersonation_ticket_seconds' => 60,
        'impersonation_minutes' => 30,
    ],
];
