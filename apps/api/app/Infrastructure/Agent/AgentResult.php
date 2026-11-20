<?php

declare(strict_types=1);

namespace App\Infrastructure\Agent;

/** Kết quả agent theo contracts/agent-ops/result.schema.json. */
final readonly class AgentResult
{
    /**
     * @param  array<string, mixed>|null  $data
     * @param  array{code: string, message: string, retryable: bool}|null  $error
     */
    public function __construct(
        public string $opId,
        public bool $ok,
        public ?array $data,
        public ?array $error,
        public int $durationMs,
        public string $agentVersion,
        public bool $cached = false,
    ) {}
}
