<?php

declare(strict_types=1);

namespace App\Auth;

/** Khóa dữ liệu phiên của ITSO. */
final class SessionKeys
{
    public const CREATED_AT = 'itso.created_at';

    /** ISO 8601; null khi chưa xác thực MFA trong phiên này. */
    public const MFA_VERIFIED_AT = 'itso.mfa_verified_at';

    public const STEP_UP_AT = 'itso.step_up_at';

    public const REMEMBER = 'itso.remember';

    /** Đăng ký TOTP chờ xác nhận: secret (đã mã hóa) + băm mã khôi phục. */
    public const TOTP_PENDING = 'itso.totp_pending';

    /** id bảng impersonation_sessions khi phiên Portal là phiên giả danh. */
    public const IMPERSONATION_ID = 'itso.impersonation_id';
}
