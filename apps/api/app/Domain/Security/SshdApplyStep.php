<?php

declare(strict_types=1);

namespace App\Domain\Security;

final class SshdApplyStep extends SafeApplyStep
{
    protected function op(): string
    {
        return 'sshd.config.apply';
    }

    protected function confirm(): bool
    {
        return false;
    }
}
