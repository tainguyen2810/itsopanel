<?php

use App\Domain\Backup\BackupJobHandler;
use App\Domain\Data\DataJobHandler;
use App\Domain\Dns\DnsRecordsStep;
use App\Domain\Hosting\AccountJobHandler;
use App\Domain\Security\FirewallApplyStep;
use App\Domain\Security\FirewallConfirmStep;
use App\Domain\Security\SecurityJobHandler;
use App\Domain\Security\SshdApplyStep;
use App\Domain\Security\SshdConfirmStep;
use App\Domain\Servers\SoftwareJobHandler;
use App\Domain\Web\CertificateJobHandler;
use App\Domain\Web\ServerWebJobHandler;
use App\Domain\Web\WebsiteJobHandler;

return [
    // Phiên bản panel; commit được truyền qua biến môi trường lúc build (không gọi git từ PHP).
    'version' => env('ITSO_VERSION', '0.1.0-alpha'),
    'commit' => env('ITSO_COMMIT', 'dev'),
    'agent_min_version' => '0.1.0',
    // Kênh cập nhật hiển thị ở /system/updates (panel không tự cập nhật; root chạy `itso update`).
    'update_channel' => env('ITSO_UPDATE_CHANNEL', 'stable'),
    // Thư mục release do installer quản lý (chỉ đọc tên thư mục để liệt kê phiên bản).
    'releases_dir' => env('ITSO_RELEASES_DIR', '/opt/itso/releases'),
    'current_link' => env('ITSO_CURRENT_LINK', '/opt/itso/current'),
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
    'relay' => [
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
    ] + array_fill_keys(['website.create', 'website.update', 'website.nginx.update', 'website.php.update',
        'website.domain.add', 'website.domain.remove', 'website.delete'], WebsiteJobHandler::class)
      + array_fill_keys(['php.version.install', 'php.version.remove', 'php.extensions.install', 'setup.stack'],
          ServerWebJobHandler::class)
      + array_fill_keys(['certificate.issue', 'certificate.upload', 'certificate.renew', 'certificate.delete'],
          CertificateJobHandler::class)
      + array_fill_keys(DataJobHandler::TYPES, DataJobHandler::class)
      + array_fill_keys(SecurityJobHandler::TYPES, SecurityJobHandler::class)
      + array_fill_keys(BackupJobHandler::TYPES, BackupJobHandler::class),

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
