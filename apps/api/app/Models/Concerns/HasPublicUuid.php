<?php

declare(strict_types=1);

namespace App\Models\Concerns;

/**
 * Bảng có `uuid` công khai (DB sinh bằng gen_random_uuid()): API và route chỉ dùng uuid,
 * không lộ `id` nội bộ.
 */
trait HasPublicUuid
{
    public function getRouteKeyName(): string
    {
        return 'uuid';
    }

    public static function bootHasPublicUuid(): void
    {
        // Sau INSERT, nạp lại uuid do DB sinh để dùng ngay trong response.
        static::created(function (self $m): void {
            if ($m->getAttribute('uuid') === null) {
                $m->setAttribute('uuid', $m->newQuery()->whereKey($m->getKey())->value('uuid'));
                $m->syncOriginalAttribute('uuid');
            }
        });
    }
}
