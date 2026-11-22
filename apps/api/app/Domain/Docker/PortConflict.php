<?php

declare(strict_types=1);

namespace App\Domain\Docker;

/** Cổng host vừa bị project khác giữ (unique server+port+protocol): kiểm lại YAML với ứng viên mới. */
final class PortConflict extends \RuntimeException
{
    public function __construct(public readonly int $port)
    {
        parent::__construct("Cổng $port đã được cấp.");
    }
}
