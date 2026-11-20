<?php

declare(strict_types=1);

namespace App\Domain\Jobs;

use Illuminate\Database\Eloquent\Model;

/**
 * Mô tả một job nghiệp vụ trước khi tạo: loại, tài nguyên, server, các bước (op agent có kiểu + params).
 * Params không được chứa bí mật (lưu ở job_steps.params_redacted để chạy lại/retry).
 */
final class JobSpec
{
    /** @var list<array{op: string, params: array<string, mixed>, compensation_op?: string|null}> */
    public array $steps = [];

    public function __construct(
        public readonly string $type,
        public readonly ?Model $resource = null,
        public readonly ?int $serverId = null,
        public int $maxAttempts = 3,
        public int $timeoutSec = 600,
    ) {}

    /** @param  array<string, mixed>  $params */
    public function step(string $op, array $params, ?string $compensationOp = null): self
    {
        $this->steps[] = ['op' => $op, 'params' => $params, 'compensation_op' => $compensationOp];

        return $this;
    }
}
