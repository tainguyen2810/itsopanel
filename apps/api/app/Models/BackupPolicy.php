<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\PgTextArray;
use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Chính sách backup (lịch + phạm vi + đích + retention mong muốn, D-86).
 *
 * @property int $id
 * @property string $uuid
 * @property string $name
 * @property string $scope_type all_accounts|hosting_account|website|database|server|panel
 * @property int|null $scope_id
 * @property list<string> $contents
 * @property list<string> $excludes
 * @property string $schedule
 * @property array<string, int> $retention
 * @property bool $enabled
 * @property Carbon|null $last_run_at
 * @property Carbon|null $next_run_at
 * @property string|null $last_status
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Collection<int, BackupDestination> $destinations
 */
class BackupPolicy extends Model
{
    use HasPublicUuid, SoftDeletes;

    protected $table = 'backup_policies';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['contents' => PgTextArray::class, 'excludes' => PgTextArray::class, 'retention' => 'array', 'enabled' => 'boolean',
            'last_run_at' => 'datetime', 'next_run_at' => 'datetime'];
    }

    /** @return BelongsToMany<BackupDestination, $this> */
    public function destinations(): BelongsToMany
    {
        return $this->belongsToMany(BackupDestination::class, 'backup_policy_destinations', 'policy_id', 'destination_id');
    }
}
