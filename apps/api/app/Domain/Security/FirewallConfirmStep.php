<?php

declare(strict_types=1);

namespace App\Domain\Security;

final class FirewallConfirmStep extends SafeApplyStep
{
    protected function op(): string
    {
        return 'firewall.confirm';
    }

    protected function confirm(): bool
    {
        return true;
    }
}
