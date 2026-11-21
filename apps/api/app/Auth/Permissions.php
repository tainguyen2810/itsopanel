<?php

declare(strict_types=1);

namespace App\Auth;

/**
 * Danh mục quyền (seed vào bảng `permissions`) và luật khớp wildcard.
 *
 * - SUPER_ADMIN: `*`.
 * - ADMIN: quyền theo nhóm, áp trong phạm vi `user_scopes` (server | hosting_account) — xem App\Auth\Access.
 * - USER: `own.*` — chỉ tài nguyên của mình (owner_user_id), kiểm ở Policy/global scope Portal.
 */
final class Permissions
{
    /** @var array<string, array<string, string>> nhóm → key → mô tả */
    public const CATALOG = [
        'wildcard' => [
            '*' => 'Toàn quyền (SUPER_ADMIN)',
            'own.*' => 'Mọi thao tác trên tài nguyên của chính mình (Portal)',
            'websites.*' => 'Website (Phase 5)',
            'databases.*' => 'Database (Phase 6)',
        ],
        'users' => [
            'users.read' => 'Xem người dùng',
            'users.write' => 'Tạo/sửa/khóa người dùng Portal trong phạm vi',
            'users.impersonate' => 'Giả danh USER Portal',
            'users.scopes' => 'Gán phạm vi cho ADMIN',
            'roles.read' => 'Xem vai trò và quyền',
            'api_tokens.manage' => 'Quản lý API token nội bộ',
        ],
        'infrastructure' => [
            'servers.read' => 'Xem máy chủ',
            'servers.write' => 'Thêm/sửa máy chủ, điều khiển dịch vụ, khởi động lại',
            'software.write' => 'Cài/gỡ phần mềm trên máy chủ (recipe)',
        ],
        'hosting' => [
            'packages.read' => 'Xem gói hosting',
            'packages.write' => 'Tạo/sửa gói hosting',
            'accounts.read' => 'Xem tài khoản hosting',
            'accounts.write' => 'Tạo/sửa/tạm ngưng tài khoản hosting',
            'accounts.terminate' => 'Chấm dứt tài khoản hosting',
        ],
        'web' => [
            'websites.read' => 'Xem website, tên miền, cấu hình Nginx/PHP, log',
            'websites.write' => 'Tạo/sửa/xóa website, tên miền và chứng chỉ',
            'dns.read' => 'Xem zone và bản ghi DNS',
            'dns.write' => 'Thêm zone, sửa bản ghi DNS (Cloudflare)',
            'dns.providers' => 'Thêm/xóa nhà cung cấp DNS (token Cloudflare)',
        ],
        'operations' => [
            'jobs.read' => 'Xem job',
            'jobs.write' => 'Hủy/thử lại job',
            'audit.read' => 'Xem nhật ký kiểm toán',
            'audit.export' => 'Xuất nhật ký kiểm toán',
            'settings.read' => 'Xem cài đặt hệ thống',
            'settings.write' => 'Sửa cài đặt hệ thống',
            'backups.read' => 'Xem sao lưu (Phase 8)',
        ],
    ];

    /** @var array<string, list<string>> */
    public const ROLE_GRANTS = [
        'SUPER_ADMIN' => ['*'],
        'ADMIN' => ['users.read', 'users.write', 'roles.read', 'servers.read', 'packages.read', 'accounts.read',
            'accounts.write', 'jobs.read', 'jobs.write', 'audit.read', 'websites.*', 'dns.read', 'dns.write', 'databases.*', 'backups.read'],
        'USER' => ['own.*'],
    ];

    /** @param  list<string>  $granted */
    public static function grants(array $granted, string $needed): bool
    {
        foreach ($granted as $g) {
            if ($g === '*' || $g === $needed) {
                return true;
            }
            if (str_ends_with($g, '.*') && str_starts_with($needed, substr($g, 0, -1))) {
                return true;
            }
        }

        return false;
    }

    /** Scope token tương ứng quyền: `users.read` → `users:read`, hành động khác read → `:write`. */
    public static function tokenScope(string $permission): string
    {
        [$group, $action] = array_pad(explode('.', $permission, 2), 2, 'read');

        return $group.':'.($action === 'read' ? 'read' : 'write');
    }
}
