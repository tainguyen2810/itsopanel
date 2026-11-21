<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Audit\AuditLogger;
use App\Domain\Users\UserService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Gỡ MFA của tài khoản admin khi mất thiết bị (`sudo itso admin reset-mfa <email>`). Lần đăng nhập tới
 * phải đăng ký lại TOTP (bắt buộc với admin). Thu hồi mọi phiên, ghi audit.
 */
final class AdminResetMfaCommand extends Command
{
    protected $signature = 'itso:admin-reset-mfa {--email= : Email tài khoản admin}';

    protected $description = 'Gỡ MFA của tài khoản admin (khôi phục truy cập từ máy chủ)';

    public function handle(UserService $users, AuditLogger $audit): int
    {
        $user = AdminResetPasswordCommand::findAdmin($this);
        if ($user === null) {
            return self::FAILURE;
        }
        $n = DB::transaction(function () use ($user, $users, $audit): int {
            $n = $user->mfaCredentials()->delete();
            $users->revokeSessions($user);
            $audit->record('user.mfa_reset_cli', $user, ['via' => 'itso admin reset-mfa', 'removed' => $n], 'success', null, null, null);

            return (int) $n;
        });
        $this->info("Đã gỡ {$n} phương thức MFA của {$user->email}; mọi phiên cũ đã bị thu hồi. Lần đăng nhập tới phải đăng ký lại TOTP.");

        return self::SUCCESS;
    }
}
