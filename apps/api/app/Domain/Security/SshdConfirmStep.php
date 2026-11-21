<?php

declare(strict_types=1);

namespace App\Domain\Security;

final class SshdConfirmStep extends SafeApplyStep
{
    protected function op(): string
    {
        return 'sshd.config.confirm';
    }

    protected function confirm(): bool
    {
        return true;
    }
}
