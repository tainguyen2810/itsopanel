<?php

declare(strict_types=1);

namespace App\Auth;

use Illuminate\Http\Request;

/**
 * Realm của request (D-58): `admin` (panel) hoặc `portal` (khách hàng).
 *
 * - /api/v1/admin/* → admin, /api/v1/portal/* → portal.
 * - /api/v1/auth/*: host khớp `itso.auth.hosts` (production, hai origin); ngược lại header `X-ITSO-Realm`
 *   (một origin: dev, demo); mặc định portal. Header giả mạo vô hại: user chỉ được tìm trong đúng realm,
 *   cookie phiên tách theo realm và realm admin còn qua IP allowlist.
 */
final class Realm
{
    public const ADMIN = 'admin';

    public const PORTAL = 'portal';

    public const ATTRIBUTE = 'itso.realm';

    public static function resolve(Request $request): string
    {
        $path = $request->path();
        if (str_starts_with($path, 'api/v1/admin/') || $path === 'api/v1/admin') {
            return self::ADMIN;
        }
        if (str_starts_with($path, 'api/v1/portal/') || $path === 'api/v1/portal') {
            return self::PORTAL;
        }
        $host = $request->getHost();
        foreach ([self::ADMIN, self::PORTAL] as $realm) {
            $h = config("itso.auth.hosts.$realm");
            if (is_string($h) && $h !== '' && strcasecmp($h, $host) === 0) {
                return $realm;
            }
        }

        return $request->header('X-ITSO-Realm') === self::ADMIN ? self::ADMIN : self::PORTAL;
    }

    public static function of(Request $request): string
    {
        $r = $request->attributes->get(self::ATTRIBUTE);

        return $r === self::ADMIN ? self::ADMIN : self::PORTAL;
    }

    public static function cookie(string $realm): string
    {
        return "itso_{$realm}_session";
    }

    public static function xsrfCookie(string $realm): string
    {
        return 'XSRF-TOKEN-'.strtoupper($realm);
    }
}
