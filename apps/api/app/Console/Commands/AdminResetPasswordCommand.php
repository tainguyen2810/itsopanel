<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Audit\AuditLogger;
use App\Domain\Users\UserService;
use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * Khôi phục truy cập Admin Panel từ máy chủ (`sudo itso admin reset-password <email>`, 10 §6).
 * Đặt mật khẩu tạm ngẫu nhiên (bắt đổi khi đăng nhập), thu hồi mọi phiên, ghi audit. Chỉ realm admin.
 */
final class AdminResetPasswordCommand extends Command
{
    protected $signature = 'itso:admin-reset-password {--email= : Email tài khoản admin}';

    protected $description = 'Đặt mật khẩu tạm cho tài khoản admin (khôi phục truy cập từ máy chủ)';

    public function handle(UserService $users, AuditLogger $audit): int
    {
        $user = self::findAdmin($this);
        if ($user === null) {
            return self::FAILURE;
        }
        $temp = Str::password(20, symbols: false);
        DB::transaction(function () use ($user, $temp, $users, $audit): void {
            $user->forceFill(['password_hash' => Hash::make($temp), 'must_change_password' => true])->save();
            $users->revokeSessions($user);
            $audit->record('user.password_reset_cli', $user, ['via' => 'itso admin reset-password'], 'success', null, null, null);
        });
        $this->info("Đã đặt mật khẩu tạm cho {$user->email} (bắt đổi ở lần đăng nhập tới, mọi phiên cũ đã bị thu hồi):");
        $this->line($temp);

        return self::SUCCESS;
    }

    /** Tìm user realm admin theo --email; in lỗi và trả null nếu không có. */
    public static function findAdmin(Command $cmd): ?User
    {
        $email = mb_strtolower(trim((string) $cmd->option('email')));
        if ($email === '' || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            $cmd->error('Cần --email hợp lệ.');

            return null;
        }
        $user = User::query()->where('realm', 'admin')->whereRaw('lower(email) = ?', [$email])->first();
        if ($user === null) {
            $cmd->error("Không có tài khoản admin {$email}.");
        }

        return $user;
    }
}
