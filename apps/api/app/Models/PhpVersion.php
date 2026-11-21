<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Phiên bản PHP trên một server (desired/observed, D-68). status: pending|provisioning|ready|failed|deleting.
 *
 * @property int $id
 * @property int $server_id
 * @property string $version
 * @property list<string> $extensions
 * @property int $spec_version
 * @property int $observed_version
 * @property string $status
 * @property array<array-key, mixed> $observed_facts
 * @property array<array-key, mixed>|null $drift
 * @property Carbon|null $observed_at
 * @property int|null $last_job_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class PhpVersion extends Model
{
    protected $table = 'php_versions';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['extensions' => 'array', 'observed_facts' => 'array', 'drift' => 'array', 'observed_at' => 'datetime'];
    }
}
