<?php

declare(strict_types=1);

namespace App\Domain\Data;

use App\Exceptions\ApiProblem;

/**
 * Biểu thức cron 5 trường số (ADR 0021): kiểm miền giống agent (DOM + DOW cùng giới hạn → từ chối, lịch không bao giờ
 * xảy ra → từ chối) và tính khoảng ngắn nhất giữa hai lần chạy để so với `cron_min_interval_min` của gói.
 */
final class CronSchedule
{
    private const FIELDS = [['phút', 0, 59], ['giờ', 0, 23], ['ngày', 1, 31], ['tháng', 1, 12], ['thứ', 0, 7]];

    /** @var list<list<int>> */
    private array $values = [];

    /** @var array<int, bool> */
    private array $star = [];

    private function __construct() {}

    public static function parse(string $expr, string $field = 'schedule'): self
    {
        $parts = preg_split('/ +/', trim($expr)) ?: [];
        if (count($parts) !== 5 || strlen($expr) > 100) {
            throw ApiProblem::field($field, 'Biểu thức cron phải có đúng 5 trường số (phút giờ ngày tháng thứ).');
        }
        $s = new self;
        foreach (self::FIELDS as $i => [$name, $min, $max]) {
            [$s->values[$i], $s->star[$i]] = self::field($parts[$i], $name, $min, $max, $field);
        }
        if (! $s->star[2] && ! $s->star[4]) {
            throw ApiProblem::field($field, 'Không hỗ trợ giới hạn cùng lúc ngày trong tháng và thứ trong tuần.');
        }
        if (! $s->star[2]) {
            $months = $s->star[3] ? range(1, 12) : $s->values[3];
            $possible = false;
            foreach ($months as $m) {
                $possible = $possible || $s->values[2][0] <= (int) date('t', (int) mktime(0, 0, 0, $m, 1, 2024));
            }
            if (! $possible) {
                throw ApiProblem::field($field, 'Lịch cron không bao giờ xảy ra.');
            }
        }

        return $s;
    }

    /** Khoảng ngắn nhất (phút) giữa hai lần chạy liên tiếp trong ngày chạy (kể cả nối sang ngày kế). */
    public function minIntervalMinutes(): int
    {
        $times = [];
        foreach ($this->values[1] as $h) {
            foreach ($this->values[0] as $m) {
                $times[] = $h * 60 + $m;
            }
        }
        sort($times);
        $min = 1440;
        for ($i = 1; $i < count($times); $i++) {
            $min = min($min, $times[$i] - $times[$i - 1]);
        }
        if ($this->star[2] && $this->star[4]) { // chạy mỗi ngày: tính cả khoảng từ lần cuối hôm nay tới lần đầu hôm sau
            $min = min($min, 1440 - $times[count($times) - 1] + $times[0]);
        }

        return max(1, $min);
    }

    /**
     * @return array{0: list<int>, 1: bool}
     */
    private static function field(string $s, string $name, int $min, int $max, string $field): array
    {
        $bad = fn (string $why): ApiProblem => ApiProblem::field($field, "Trường $name: $why.");
        if ($s === '*') {
            return [range($min, $max), true];
        }
        $set = [];
        foreach (explode(',', $s) as $term) {
            if ($term === '') {
                throw $bad('thiếu giá trị');
            }
            [$rng, $stepS] = array_pad(explode('/', $term, 2), 2, null);
            $step = 1;
            if ($stepS !== null) {
                if (! ctype_digit($stepS) || (int) $stepS < 1 || (int) $stepS > $max) {
                    throw $bad("bước $stepS không hợp lệ");
                }
                $step = (int) $stepS;
            }
            if ($rng === '*') {
                [$lo, $hi] = [$min, $max];
            } elseif (preg_match('/^([0-9]+)-([0-9]+)$/', (string) $rng, $m) === 1) {
                [$lo, $hi] = [(int) $m[1], (int) $m[2]];
                if ($lo > $hi) {
                    throw $bad("khoảng $rng ngược");
                }
            } elseif (ctype_digit((string) $rng)) {
                $lo = (int) $rng;
                $hi = $stepS !== null ? $max : $lo;
            } else {
                throw $bad("giá trị $rng không hợp lệ");
            }
            if ($lo < $min || $hi > $max || $lo > $hi) { // "a/n" với a vượt max → tập rỗng
                throw $bad("ngoài miền {$min}–{$max}");
            }
            for ($v = $lo; $v <= $hi; $v += $step) {
                $set[$v] = true;
            }
        }
        $out = array_keys($set);
        sort($out);

        return [$out, false];
    }
}
