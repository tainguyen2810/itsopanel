<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Revision bất biến của compose project (ADR 0041).
 *
 * @property int $id
 * @property int $project_id
 * @property int $number
 * @property string $yaml
 * @property string|null $validated_yaml
 * @property string|null $validated_sha256
 * @property bool $ok
 * @property int $findings_count
 * @property array<string, mixed>|null $validation_report
 * @property list<array<string, mixed>> $overrides
 * @property int|null $created_by_user_id
 * @property Carbon $created_at
 */
class ComposeRevision extends Model
{
    public const UPDATED_AT = null;

    protected $table = 'compose_revisions';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['ok' => 'boolean', 'validation_report' => 'array', 'overrides' => 'array'];
    }
}
