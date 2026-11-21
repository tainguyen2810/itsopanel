<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Database của account (Phase 6, D-71). engine: mariadb|postgresql. Desired ở bảng này; observed qua job.
 *
 * @property int $id
 * @property string $uuid
 * @property int $hosting_account_id
 * @property int $server_id
 * @property string $engine
 * @property string $name
 * @property string $charset
 * @property int|null $size_mb
 * @property int $spec_version
 * @property int $observed_version
 * @property string $status
 * @property array<array-key, mixed> $observed_facts
 * @property array<array-key, mixed>|null $drift
 * @property Carbon|null $observed_at
 * @property int|null $last_job_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property Carbon|null $deleted_at
 * @property-read HostingAccount $account
 */
class Database extends Model
{
    use HasPublicUuid, SoftDeletes;

    protected $table = 'databases';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['observed_facts' => 'array', 'drift' => 'array', 'observed_at' => 'datetime'];
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id')->withTrashed();
    }
}
