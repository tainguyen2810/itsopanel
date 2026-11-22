<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Phần mềm trên một server (desired/observed). status: pending|provisioning|ready|failed|deleting.
 *
 * @property int $id
 * @property int $server_id
 * @property string $software_key
 * @property string|null $version
 * @property int $spec_version
 * @property int $observed_version
 * @property string $status
 * @property string $state available|installing|installed|upgradable|upgrading|removing|failed (Phase 10)
 * @property string|null $latest_version
 * @property bool $upgrade_available
 * @property array<array-key, mixed> $observed_facts
 * @property array<array-key, mixed>|null $drift
 * @property Carbon|null $observed_at
 * @property int|null $last_job_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class ServerSoftware extends Model
{
    protected $table = 'server_software';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['observed_facts' => 'array', 'drift' => 'array', 'observed_at' => 'datetime', 'upgrade_available' => 'boolean'];
    }
}
