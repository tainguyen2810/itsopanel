<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Auth\SessionKeys;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Đặt sau StartSession: phiên đăng nhập không chọn "ghi nhớ" dùng cookie hết khi đóng trình duyệt.
 * StartSession đọc cấu hình cookie sau khi middleware bên trong trả về, nên đặt ở đây là kịp.
 */
final class ApplyRememberPreference
{
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);
        if ($request->hasSession()) {
            config(['session.expire_on_close' => $request->session()->get(SessionKeys::REMEMBER) !== true]);
        }

        return $response;
    }
}
