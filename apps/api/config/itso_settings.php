<?php

/*
 * Cài đặt hệ thống theo nhóm (GET/PATCH /admin/settings/{group}, chỉ SUPER_ADMIN).
 * default = giá trị khi chưa lưu; rules = luật validate Laravel; secret = lưu mã hóa, không bao giờ trả về
 * (GET trả `<key>_set: true|false`).
 */
return [
    'general' => [
        'panel_name' => ['default' => 'ITSO Panel', 'rules' => ['string', 'min:1', 'max:60']],
        'default_locale' => ['default' => 'vi', 'rules' => ['in:vi,en']],
        'timezone' => ['default' => 'Asia/Ho_Chi_Minh', 'rules' => ['string', 'timezone:all']],
    ],
    'security' => [
        // MFA cho quản trị viên luôn bật (D-58), giữ khóa để UI hiển thị.
        'admin_mfa_required' => ['default' => true, 'rules' => ['boolean', 'accepted']],
        'session_lifetime_min' => ['default' => 120, 'rules' => ['integer', 'between:15,720']],
        // CAPTCHA proof-of-work (ADR 0028): sau N lần sai theo IP hoặc email; 0 = luôn bật.
        'portal_captcha_after_failures' => ['default' => 3, 'rules' => ['integer', 'between:0,10']],
        // Bắt buộc USER Portal bật MFA (ADR 0028 §2).
        'portal_mfa_required' => ['default' => false, 'rules' => ['boolean']],
    ],
    'smtp' => [
        'host' => ['default' => '', 'rules' => ['string', 'max:255']],
        'port' => ['default' => 587, 'rules' => ['integer', 'between:1,65535']],
        'username' => ['default' => '', 'rules' => ['string', 'max:255']],
        'password' => ['default' => null, 'rules' => ['nullable', 'string', 'max:500'], 'secret' => true],
        'from' => ['default' => 'ITSO Panel <panel@itso.local>', 'rules' => ['string', 'max:255']],
        'encryption' => ['default' => 'starttls', 'rules' => ['in:none,starttls,tls']],
    ],
    'backup' => [
        'default_retention_days' => ['default' => 30, 'rules' => ['integer', 'between:1,3650']],
        'verify_after_backup' => ['default' => true, 'rules' => ['boolean']],
    ],
    'updates' => [
        'channel' => ['default' => 'stable', 'rules' => ['in:stable,beta']],
        'auto_check' => ['default' => true, 'rules' => ['boolean']],
    ],
];
