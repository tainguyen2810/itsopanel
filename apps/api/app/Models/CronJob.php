<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Cron job của account (D-74): systemd timer trong slice account; desired state theo account (cron.apply).
 *
 * @property int $id
 * @property string $uuid
 * @property int $hosting_account_id
 * @property int|null $website_id
 * @property string $schedule
 * @property string $command
 * @property string $working_dir
 * @property string|null $php_version
 * @property int $timeout_sec
 * @property bool $enabled
 * @property Carbon|null $last_run_at
 * @property string|null $last_status
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
class CronJob extends Model
{
    use HasPublicUuid, SoftDeletes;

    protected $table = 'cron_jobs';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['enabled' => 'boolean', 'last_run_at' => 'datetime', 'observed_facts' => 'array', 'drift' => 'array', 'observed_at' => 'datetime'];
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id')->withTrashed();
    }
}
