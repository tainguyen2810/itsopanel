<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Auth\Realm;
use App\Exceptions\ApiProblem;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/**
 * IP allowlist (bảng ip_allowlist): realm admin chỉ nhận IP thuộc CIDR scope `admin`; request bằng API token
 * kiểm thêm scope `api`. Danh sách trống = không giới hạn (cài mới chưa cấu hình).
 */
final class EnsureIpAllowed
{
    public function handle(Request $request, Closure $next): Response
    {
        $bearer = $request->bearerToken() !== null;
        if (Realm::of($request) === Realm::ADMIN && ! self::allowed('admin', (string) $request->ip())) {
            throw self::denied();
        }
        if ($bearer && ! self::allowed('api', (string) $request->ip())) {
            throw self::denied();
        }

        return $next($request);
    }

    public static function allowed(string $scope, string $ip): bool
    {
        $row = DB::selectOne(
            'SELECT count(*) AS n, bool_or(?::inet <<= cidr) AS ok FROM ip_allowlist WHERE scope = ?', [$ip, $scope]);

        return (int) $row->n === 0 || $row->ok === true;
    }

    private static function denied(): ApiProblem
    {
        return new ApiProblem(403, 'ip_not_allowed', 'IP không được phép', 'Địa chỉ IP không nằm trong danh sách cho phép.');
    }
}
