<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Audit\AuditLogger;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Cứu hộ khi IP allowlist Admin khóa chính mình (ADR 0028): `itso allowlist reset` trên máy chủ (root) gọi lệnh này.
 * Không có endpoint web tương đương.
 */
final class AllowlistResetCommand extends Command
{
    protected $signature = 'itso:allowlist-reset';

    protected $description = 'Xóa IP allowlist Admin (mọi IP vào được trang quản trị)';

    public function handle(AuditLogger $audit): int
    {
        $before = DB::table('ip_allowlist')->where('scope', 'admin')->orderBy('cidr')->pluck('cidr')->map(fn ($c): string => (string) $c)->all();
        $n = DB::table('ip_allowlist')->where('scope', 'admin')->delete();
        $audit->record('security.ip_allowlist_reset', null, ['from' => $before, 'via' => 'cli'], 'success');
        $this->info($n > 0 ? "Đã xóa {$n} mục IP allowlist Admin. Trang quản trị mở cho mọi IP; đặt lại allowlist trong Bảo mật › IP allowlist."
            : 'IP allowlist Admin đang trống, không có gì để xóa.');

        return self::SUCCESS;
    }
}
