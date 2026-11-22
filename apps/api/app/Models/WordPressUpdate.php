<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Một lượt cập nhật an toàn (D-99): snapshot → maintenance → update → verify → (rollback).
 *
 * @property int $id
 * @property string $uuid
 * @property int $wordpress_site_id
 * @property int|null $job_id
 * @property string $trigger manual|auto
 * @property list<array<string, mixed>> $items
 * @property list<array{key: string, state: string}> $steps
 * @property string $state running|succeeded|rolled_back|failed
 * @property int|null $snapshot_id
 * @property string|null $error
 * @property int|null $requested_by_user_id
 * @property Carbon|null $started_at
 * @property Carbon|null $finished_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class WordPressUpdate extends Model
{
    use HasPublicUuid;

    protected $table = 'wordpress_updates';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['items' => 'array', 'steps' => 'array', 'started_at' => 'datetime', 'finished_at' => 'datetime'];
    }
}
