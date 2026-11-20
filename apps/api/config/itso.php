<?php

return [
    // Phiên bản panel; commit được truyền qua biến môi trường lúc build (không gọi git từ PHP).
    'version' => env('ITSO_VERSION', '0.1.0-alpha'),
    'commit' => env('ITSO_COMMIT', 'dev'),
    'agent_min_version' => '0.1.0',

    'agent' => [
        // Linux: unix socket. Windows dev: ITSO_AGENT_URL=http://127.0.0.1:7810.
        'socket' => env('ITSO_AGENT_SOCKET', '/tmp/itso-mock-agent.sock'),
        'url' => env('ITSO_AGENT_URL'),
        'timeout' => (float) env('ITSO_AGENT_TIMEOUT', 5),
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
