<?php

declare(strict_types=1);

namespace App\Domain\Jobs;

final class PanelStepFailed extends \RuntimeException
{
    public function __construct(public readonly string $errorCode, string $message, public readonly bool $retryable = false)
    {
        parent::__construct($message);
    }
}
