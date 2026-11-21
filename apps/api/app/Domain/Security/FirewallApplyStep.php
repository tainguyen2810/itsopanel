<?php

declare(strict_types=1);

namespace App\Domain\Security;

final class FirewallApplyStep extends SafeApplyStep
{
    protected function op(): string
    {
        return 'firewall.apply';
    }

    protected function confirm(): bool
    {
        return false;
    }
}
