<?php

declare(strict_types=1);

namespace App\Domain\Jobs;

use App\Http\Presenters\JobPresenter;
use App\Models\Job;
use App\Models\JobLog;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Redis;

/**
 * Sự kiện job realtime (D-106, ADR 0051).
 * - Phát: mỗi dòng job_logs (mọi thay đổi bước/trạng thái của JobRunner đều có log) → Redis PUBLISH `itso:job:<uuid>`.
 * - Đọc (SSE): job_logs là nguồn sự thật có thứ tự, `id` = seq log nên nối lại bằng Last-Event-ID không mất sự kiện;
 *   snapshot job gửi khi trạng thái/tiến độ đổi (kể cả đổi không kèm log như cancel_requested).
 */
class JobEvents
{
    public const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timed_out'];

    public static function channel(string $uuid): string
    {
        return 'itso:job:'.$uuid;
    }

    /** Phát một dòng log (lỗi Redis không làm hỏng job). */
    public function published(JobLog $l): void
    {
        try {
            $uuid = Job::query()->whereKey($l->job_id)->value('uuid');
            if (is_string($uuid)) {
                Redis::connection()->publish(self::channel($uuid), json_encode(['id' => $l->id] + JobPresenter::log($l),
                    JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
            }
        } catch (\Throwable $e) {
            Log::debug('job event publish failed: '.$e::class);
        }
    }

    /**
     * Khung SSE kể từ $after (seq log): các dòng log mới, kèm snapshot job khi trạng thái/tiến độ khác $lastSnap.
     *
     * @return array{0: string, 1: int, 2: string, 3: bool} [khung, seq cuối, chữ ký snapshot, job đã kết thúc]
     */
    public function frames(Job $job, string $realm, int $after, string $lastSnap, JobPresenter $present): array
    {
        $out = '';
        $logs = JobLog::query()->where('job_id', $job->id)->where('id', '>', $after)->orderBy('id')->limit(500)->get();
        foreach ($logs as $l) {
            $after = $l->id;
            $out .= self::frame('log', $after, JobPresenter::log($l));
        }
        $job->refresh();
        $snap = $job->state.'|'.$job->progress.'|'.$job->attempts.'|'.($job->error_code ?? '');
        if ($snap !== $lastSnap) {
            $out .= self::frame('job', $after, $present->job($job, $realm));
        }
        $drained = $logs->count() < 500;

        return [$out, $after, $snap, $drained && in_array($job->state, self::TERMINAL, true)];
    }

    /** @param  array<string, mixed>  $data */
    public static function frame(string $event, int $id, array $data): string
    {
        return ($id > 0 ? "id: $id\n" : '')."event: $event\ndata: ".json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n\n";
    }
}
