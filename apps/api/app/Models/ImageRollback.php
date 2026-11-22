<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Lần cập nhật image có rollback (D-98, ADR 0043).
 *
 * @property int $id
 * @property int $compose_project_id
 * @property string $service
 * @property string $from_digest
 * @property string $to_digest
 * @property string $rollback_tag
 * @property string $state running|succeeded|rolled_back|failed
 * @property string|null $reason
 * @property int|null $job_id
 * @property int|null $requested_by_user_id
 * @property Carbon|null $released_at
 * @property Carbon $created_at
 */
class ImageRollback extends Model
{
    public const UPDATED_AT = null;

    protected $table = 'image_rollbacks';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['released_at' => 'datetime'];
    }
}
