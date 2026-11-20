<?php

declare(strict_types=1);

namespace App\Auth;

use Illuminate\Session\DatabaseSessionHandler;

/**
 * Handler phiên trên bảng `sessions` (DBML): ghi thêm `realm` và `mfa_verified_at`.
 * Dữ liệu phiên lấy từ session store hiện tại (payload có thể đã mã hóa khi SESSION_ENCRYPT=true).
 */
final class RealmSessionHandler extends DatabaseSessionHandler
{
    /**
     * @param  string  $data
     * @return array<string, mixed>
     */
    protected function getDefaultPayload($data)
    {
        $payload = parent::getDefaultPayload($data);
        if ($this->container === null) {
            $payload['realm'] = Realm::PORTAL;

            return $payload;
        }
        $request = $this->container->make('request');
        $payload['realm'] = Realm::of($request);
        $mfa = null;
        if ($this->container->bound('session')) {
            $v = $this->container->make('session')->driver()->get(SessionKeys::MFA_VERIFIED_AT);
            $mfa = is_string($v) ? $v : null;
        }
        $payload['mfa_verified_at'] = $mfa;

        return $payload;
    }
}
