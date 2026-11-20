<?php

declare(strict_types=1);

namespace App\Domain\Hosting;

use App\Exceptions\ApiProblem;
use App\Models\HostingAccount;

/**
 * Máy trạng thái vòng đời account (D-46). Trạng thái lifecycle là desired (đổi ngay khi nhận yêu cầu);
 * `status` + `observed_version` là observed (đổi khi job agent xong). Riêng tạo mới: provisioning → active | failed
 * theo kết quả job.
 */
final class AccountLifecycle
{
    /** hành động → trạng thái nguồn hợp lệ */
    public const FROM = [
        'suspend' => ['active'],
        'unsuspend' => ['suspended'],
        'restore' => ['terminated'],
        'terminate' => ['active', 'suspended', 'failed'],
        'change_package' => ['active', 'suspended'],
        'update' => ['pending', 'provisioning', 'active', 'suspended', 'failed'],
    ];

    /** hành động → trạng thái đích */
    public const TO = ['suspend' => 'suspended', 'unsuspend' => 'active', 'restore' => 'active', 'terminate' => 'terminated'];

    /** lifecycle → status observed khi agent đã áp dụng xong */
    public const STATUS = ['active' => 'ready', 'suspended' => 'suspended', 'terminated' => 'suspended',
        'provisioning' => 'provisioning', 'pending' => 'pending', 'failed' => 'failed', 'migrating' => 'ready', 'purged' => 'deleting'];

    public static function allows(string $action, string $state): bool
    {
        return in_array($state, self::FROM[$action] ?? [], true);
    }

    public static function assert(string $action, HostingAccount $a): void
    {
        if (! self::allows($action, $a->lifecycle_state)) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Không chuyển được trạng thái',
                "Không thể $action khi account đang {$a->lifecycle_state}.");
        }
    }
}
