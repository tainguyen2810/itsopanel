<?php

declare(strict_types=1);

namespace App\Domain\Hosting;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Cấp UID 20000–59999 theo server (uid_allocations). UID đã nhả chỉ được dùng lại sau 90 ngày (tránh file mồ côi
 * mang UID cũ thuộc về account mới). Gọi trong transaction; khóa tư vấn theo server tuần tự hóa việc cấp.
 */
final class UidAllocator
{
    public const MIN = 20000;

    public const MAX = 59999;

    public const REUSE_AFTER_DAYS = 90;

    public function allocate(int $serverId, ?int $accountId = null): int
    {
        DB::select('SELECT pg_advisory_xact_lock(?, ?)', [hexdec(substr(sha1('itso_uid'), 0, 7)), $serverId]);
        $reuse = DB::table('uid_allocations')->where('server_id', $serverId)->whereNotNull('released_at')
            ->where('released_at', '<', Carbon::now()->subDays(self::REUSE_AFTER_DAYS))
            ->orderBy('uid')->lockForUpdate()->first();
        if ($reuse !== null) {
            DB::table('uid_allocations')->where('id', $reuse->id)->update(['hosting_account_id' => $accountId,
                'allocated_at' => Carbon::now(), 'released_at' => null]);

            return (int) $reuse->uid;
        }
        $max = DB::table('uid_allocations')->where('server_id', $serverId)->max('uid');
        $used = DB::table('hosting_accounts')->where('server_id', $serverId)->max('uid');
        $uid = max(self::MIN - 1, (int) $max, (int) $used) + 1;
        if ($uid > self::MAX) {
            throw new \OverflowException('Hết UID trên server.');
        }
        DB::table('uid_allocations')->insert(['server_id' => $serverId, 'uid' => $uid, 'hosting_account_id' => $accountId,
            'allocated_at' => Carbon::now()]);

        return $uid;
    }

    public function bind(int $serverId, int $uid, int $accountId): void
    {
        DB::table('uid_allocations')->where('server_id', $serverId)->where('uid', $uid)->update(['hosting_account_id' => $accountId]);
    }

    public function release(int $serverId, int $uid): void
    {
        DB::table('uid_allocations')->where('server_id', $serverId)->where('uid', $uid)->whereNull('released_at')
            ->update(['released_at' => Carbon::now()]);
    }
}
