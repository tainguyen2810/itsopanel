<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\HostingAccount;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;

/**
 * Đọc mức dùng (disk, inode, CPU, RAM) qua op quota.report, ghi vào hosting_accounts.observed_facts.usage
 * (Phase 4 chuyển sang account_usage_snapshots + scheduler).
 */
final class UsageRefreshCommand extends Command
{
    protected $signature = 'itso:usage-refresh';

    protected $description = 'Cập nhật mức dùng của các hosting account từ agent (quota.report)';

    public function handle(AgentClient $agent): int
    {
        $accounts = HostingAccount::query()->whereIn('lifecycle_state', ['active', 'suspended'])->orderBy('id')->get();
        if ($accounts->isEmpty()) {
            $this->info('Không có account active/suspended.');

            return self::SUCCESS;
        }
        try {
            $res = $agent->call('quota.report', ['accounts' => $accounts->map(fn (HostingAccount $a): array => [
                'username' => $a->username, 'uid' => $a->uid])->values()->all()]);
        } catch (AgentUnavailable $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }
        if (! $res->ok) {
            $this->error('quota.report lỗi: '.($res->error['message'] ?? ''));

            return self::FAILURE;
        }
        $byUser = collect((array) ($res->data['usage'] ?? []))->keyBy('username');
        $now = Carbon::now()->toIso8601String();
        foreach ($accounts as $a) {
            $u = $byUser->get($a->username);
            if (! is_array($u)) {
                continue;
            }
            $facts = $a->observed_facts;
            $facts['usage'] = ['disk_mb' => (int) $u['disk_mb'], 'inodes' => (int) $u['inodes'], 'cpu_pct' => (float) $u['cpu_pct'],
                'ram_mb' => (int) $u['ram_mb'], 'at' => $now];
            $a->forceFill(['observed_facts' => $facts])->saveQuietly();
        }
        $this->info("Đã cập nhật {$byUser->count()} account.");

        return self::SUCCESS;
    }
}
