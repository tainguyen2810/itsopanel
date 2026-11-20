<?php

declare(strict_types=1);

namespace App\Domain\Jobs;

use App\Models\Job;

/**
 * Hook theo loại job (đăng ký ở config itso.job_handlers): cập nhật desired/observed state khi job kết thúc.
 * Chạy trong transaction của JobRunner.
 */
interface JobHandler
{
    public function succeeded(Job $job): void;

    /** Job thất bại / hết giờ / bị hủy (state cuối). */
    public function failed(Job $job): void;
}
