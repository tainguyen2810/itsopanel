<?php

declare(strict_types=1);

namespace App\Domain\Monitoring;

use App\Models\Alert;
use App\Models\AlertRule;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Carbon;

/**
 * Bộ máy đánh giá cảnh báo (D-102, ADR 0047). Gọi mỗi phút bởi `itso:alerts-evaluate`.
 *
 * - Vượt ngưỡng: chưa có cảnh báo mở → pending (hoặc firing ngay khi duration_sec = 0 / mất kết nối agent);
 *   pending đủ duration_sec → firing (thông báo).
 * - Firing: nhắc lại sau repeat_sec nếu chưa ack và không đang silence.
 * - Dưới ngưỡng: pending → resolved ngay (không thông báo); firing → resolved sau 2 lượt liên tiếp (hysteresis).
 * - Không có số liệu: giữ nguyên trạng thái (server mất kết nối do rule agent_offline_sec báo).
 * - Rule tắt/xóa phạm vi: cảnh báo mở của rule được resolved.
 * Khóa trùng: fingerprint "r<rule>:<loại>:<id>", unique khi chưa resolved (extras.sql).
 */
final class AlertEngine
{
    public const RESOLVE_AFTER = 2;

    public function __construct(
        private readonly AlertMetrics $metrics,
        private readonly AlertEvents $events,
        private readonly DefaultAlertRules $defaults,
    ) {}

    /** @return array{rules: int, firing: int, resolved: int, notified: int} */
    public function evaluate(?Carbon $now = null): array
    {
        $now ??= Carbon::now();
        $this->defaults->ensure();
        $stats = ['rules' => 0, 'firing' => 0, 'resolved' => 0, 'notified' => 0];
        // Rule tắt: đóng cảnh báo mở.
        $disabled = AlertRule::query()->where('enabled', false)->pluck('id');
        Alert::query()->whereIn('rule_id', $disabled)->where('state', '<>', 'resolved')->get()
            ->each(function (Alert $a) use ($now, &$stats): void {
                $this->resolve($a, $now, $a->state === 'firing');
                $stats['resolved']++;
            });
        foreach (AlertRule::query()->where('enabled', true)->orderBy('id')->get() as $rule) {
            $stats['rules']++;
            $this->rule($rule, $now, $stats);
        }

        return $stats;
    }

    /** @param  array{rules: int, firing: int, resolved: int, notified: int}  $stats */
    private function rule(AlertRule $rule, Carbon $now, array &$stats): void
    {
        $open = Alert::query()->where('rule_id', $rule->id)->where('state', '<>', 'resolved')->get()->keyBy('fingerprint');
        $seen = [];
        foreach ($this->metrics->targets($rule, $now) as $t) {
            $fp = "r{$rule->id}:{$t['type']}:{$t['id']}";
            $seen[$fp] = true;
            /** @var Alert|null $a */
            $a = $open->get($fp);
            if ($t['value'] === null) {
                continue;
            }
            $hit = self::compare($t['value'], $rule->operator, $rule->threshold);
            if ($hit) {
                $a = $a ?? $this->open($rule, $t, $fp, $now);
                if ($a === null) {
                    continue;
                }
                $a->below_count = 0;
                $a->value = $t['value'];
                $a->message = $this->message($rule, $t['label'], $t['value']);
                $immediate = $rule->duration_sec === 0 || $rule->metric === 'agent_offline_sec';
                if ($a->state === 'pending' && ($immediate || $a->started_at->diffInSeconds($now, true) >= $rule->duration_sec)) {
                    $a->state = 'firing';
                    $a->firing_at = $now;
                    $stats['firing']++;
                    if (! $a->silenced($now)) {
                        $a->last_notified_at = $now;
                        $a->save();
                        $this->events->emit($a, 'firing');
                        $stats['notified']++;

                        continue;
                    }
                } elseif ($a->state === 'firing' && $this->repeatDue($rule, $a, $now)) {
                    $a->last_notified_at = $now;
                    $a->save();
                    $this->events->emit($a, 'repeat');
                    $stats['notified']++;

                    continue;
                }
                $a->save();

                continue;
            }
            if ($a === null) {
                continue;
            }
            if ($a->state === 'pending') {
                $this->resolve($a, $now, false);
                $stats['resolved']++;

                continue;
            }
            $a->below_count++;
            $a->value = $t['value'];
            if ($a->below_count >= self::RESOLVE_AFTER) {
                $this->resolve($a, $now, true);
                $stats['resolved']++;

                continue;
            }
            $a->save();
        }
        // Đối tượng không còn trong phạm vi (xóa server/account/website, đổi phạm vi rule): đóng cảnh báo.
        foreach ($open as $fp => $a) {
            if (! isset($seen[$fp])) {
                $this->resolve($a, $now, false);
                $stats['resolved']++;
            }
        }
    }

    /** @param  array{type: string, id: int, uuid: string, label: string, server_id: int|null, account_id: int|null, website_id: int|null, value: float|null}  $t */
    private function open(AlertRule $rule, array $t, string $fp, Carbon $now): ?Alert
    {
        try {
            return Alert::query()->create(['rule_id' => $rule->id, 'server_id' => $t['server_id'], 'hosting_account_id' => $t['account_id'],
                'website_id' => $t['website_id'], 'fingerprint' => $fp, 'state' => 'pending', 'severity' => $rule->severity,
                'value' => $t['value'], 'started_at' => $now, 'below_count' => 0]);
        } catch (UniqueConstraintViolationException) {
            return null; // lượt đánh giá khác vừa mở cảnh báo này (withoutOverlapping nên hiếm)
        }
    }

    private function repeatDue(AlertRule $rule, Alert $a, Carbon $now): bool
    {
        if ($rule->repeat_sec <= 0 || $a->acked_at !== null || $a->silenced($now)) {
            return false;
        }

        return $a->last_notified_at === null || $a->last_notified_at->diffInSeconds($now, true) >= $rule->repeat_sec;
    }

    private function resolve(Alert $a, Carbon $now, bool $notify): void
    {
        $wasFiring = $a->state === 'firing';
        $a->state = 'resolved';
        $a->resolved_at = $now;
        $a->save();
        if ($notify && $wasFiring && ! $a->silenced($now)) {
            $this->events->emit($a, 'resolved');
        }
    }

    public static function compare(float $v, string $op, float $threshold): bool
    {
        return match ($op) {
            'gt' => $v > $threshold,
            'gte' => $v >= $threshold,
            'lt' => $v < $threshold,
            default => $v <= $threshold,
        };
    }

    public function message(AlertRule $rule, string $label, float $value): string
    {
        $sym = ['gt' => '>', 'gte' => '≥', 'lt' => '<', 'lte' => '≤'][$rule->operator] ?? $rule->operator;
        $fmt = fn (float $x): string => rtrim(rtrim(number_format($x, 1, ',', '.'), '0'), ',');
        $unit = AlertMetrics::isPct($rule->metric) ? '%' : '';

        return mb_substr(sprintf('%s %s: %s%s (ngưỡng %s %s%s)', AlertMetrics::LABELS[$rule->metric] ?? $rule->metric, $label,
            $fmt($value), $unit, $sym, $fmt($rule->threshold), $unit), 0, 500);
    }
}
