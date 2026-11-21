<?php

declare(strict_types=1);

namespace App\Domain\Jobs;

use App\Models\Job;

/**
 * Bước job chạy trong panel thay vì gửi agent (vd `dns.records.apply` gọi Cloudflare, D-70). Đăng ký ở
 * `config('itso.panel_steps')`: op → lớp. Lỗi ném PanelStepFailed (mã lỗi theo catalog agent, cờ thử lại).
 */
interface PanelStep
{
    /**
     * @param  array<string, mixed>  $params  params đã lưu của bước (không chứa bí mật)
     * @return array<string, mixed> kết quả lưu vào job_steps.result
     */
    public function run(array $params, Job $job): array;
}
