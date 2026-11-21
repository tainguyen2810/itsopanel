<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Exceptions\ApiProblem;
use App\Models\FirewallApply;
use App\Models\Server;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;

/**
 * Safe-apply dùng chung cho tường lửa và sshd (D-76/D-77, ADR 0023/0024). Bản ghi firewall_applies chỉ giữ
 * sha256(token); token thô do agent sinh nằm trong cache (mã hóa, hết hạn cùng hạn hoàn tác) để bước confirm của
 * request mới gửi lại cho agent. Không xác nhận kịp → agent tự hoàn tác; panel đánh dấu rolled_back khi quá hạn.
 */
final class SafeApply
{
    /** Panel chờ thêm sau hạn của agent trước khi tự đánh dấu hoàn tác (đồng hồ lệch, timer trễ). */
    public const GRACE_SEC = 15;

    public const OPS = [
        'firewall' => ['apply' => 'firewall.apply', 'confirm' => 'firewall.confirm', 'job' => 'firewall.apply', 'confirm_job' => 'firewall.confirm'],
        'sshd' => ['apply' => 'sshd.config.apply', 'confirm' => 'sshd.config.confirm', 'job' => 'sshd.update', 'confirm_job' => 'sshd.confirm'],
    ];

    public function __construct(private readonly SecurityEvents $events) {}

    /**
     * Tạo lần áp dụng pending (mỗi máy chủ một lần chờ cho mỗi loại → 409).
     *
     * @param  array<string, mixed>  $spec
     * @param  array<string, mixed>|null  $previous
     */
    public function begin(Server $s, string $target, User $actor, string $clientIp, array $spec, ?array $previous, int $rollbackSec): FirewallApply
    {
        $this->expireStale($s);
        try {
            /** @var FirewallApply */
            return FirewallApply::query()->create(['server_id' => $s->id, 'target' => $target, 'user_id' => $actor->id,
                'client_ip' => $clientIp, 'spec' => $spec, 'previous' => $previous, 'status' => 'pending_confirm',
                'deadline_at' => Carbon::now()->addSeconds($rollbackSec + 60), 'created_at' => Carbon::now()]);
        } catch (QueryException $e) {
            if (str_contains($e->getMessage(), 'firewall_applies_one_pending')) {
                throw new ApiProblem(409, 'resource_locked', 'Đang chờ xác nhận lần áp dụng trước',
                    'Xác nhận hoặc chờ lần áp dụng trước tự hoàn tác rồi thử lại.');
            }
            throw $e;
        }
    }

    public function pending(Server $s, string $target): ?FirewallApply
    {
        $this->expireStale($s);

        return FirewallApply::query()->where('server_id', $s->id)->where('target', $target)
            ->where('status', 'pending_confirm')->first();
    }

    public function last(Server $s, string $target): ?FirewallApply
    {
        $this->expireStale($s);

        return FirewallApply::query()->where('server_id', $s->id)->where('target', $target)
            ->whereIn('status', ['pending_confirm', 'confirmed', 'rolled_back'])->orderByDesc('id')->first();
    }

    /** Quá hạn mà chưa xác nhận → rolled_back + sự kiện high. Trả số bản ghi đã đánh dấu. */
    public function expireStale(?Server $s = null): int
    {
        $q = FirewallApply::query()->where('status', 'pending_confirm')
            ->where('deadline_at', '<', Carbon::now()->subSeconds(self::GRACE_SEC));
        if ($s !== null) {
            $q->where('server_id', $s->id);
        }
        $n = 0;
        foreach ($q->get() as $a) {
            $this->rolledBack($a, 'Không xác nhận trong thời hạn: agent đã khôi phục cấu hình trước đó.');
            $n++;
        }

        return $n;
    }

    public function rolledBack(FirewallApply $a, string $why): void
    {
        $updated = FirewallApply::query()->whereKey($a->id)->where('status', 'pending_confirm')
            ->update(['status' => 'rolled_back', 'rolled_back_at' => Carbon::now()]);
        Cache::forget(self::cacheKey($a->uuid));
        if ($updated > 0) {
            $label = $a->target === 'sshd' ? 'SSH' : 'Tường lửa';
            $this->events->record($a->target.'.rolled_back', 'high', "$label: $why", $a->server_id, null, $a->client_ip,
                ['apply_uuid' => $a->uuid]);
        }
    }

    /** Lưu token (mã hóa) tới hết hạn hoàn tác; DB chỉ giữ sha256. */
    public static function rememberToken(FirewallApply $a, string $token, Carbon $rollbackAt): void
    {
        $ttl = max(60, (int) Carbon::now()->diffInSeconds($rollbackAt, false) + self::GRACE_SEC + 60);
        Cache::put(self::cacheKey($a->uuid), Crypt::encryptString($token), $ttl);
        $a->token_hash = hash('sha256', $token);
        $a->deadline_at = $rollbackAt;
        $a->save();
    }

    public static function token(FirewallApply $a): ?string
    {
        $enc = Cache::get(self::cacheKey($a->uuid));
        if (! is_string($enc)) {
            return null;
        }
        $t = Crypt::decryptString($enc);

        return $a->token_hash !== null && hash_equals($a->token_hash, hash('sha256', $t)) ? $t : null;
    }

    public static function cacheKey(string $uuid): string
    {
        return 'itso:safe-apply:'.$uuid;
    }
}
