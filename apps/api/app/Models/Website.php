<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Website của hosting account (Phase 5, D-67/D-68). Desired state ở bảng này + website_settings; observed qua job.
 * status: pending|provisioning|ready|degraded|failed|suspended|deleting.
 *
 * @property int $id
 * @property string $uuid
 * @property int $hosting_account_id
 * @property int $server_id
 * @property string $primary_domain
 * @property string $type
 * @property string $document_root
 * @property string|null $php_version
 * @property string $ssl_mode
 * @property int|null $compose_project_id Phase 10: website loại docker
 * @property string|null $compose_service
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
 * @property-read Server $server
 * @property-read WebsiteSetting|null $settings
 */
class Website extends Model
{
    use HasPublicUuid, SoftDeletes;

    protected $table = 'websites';

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

    /** @return BelongsTo<Server, $this> */
    public function server(): BelongsTo
    {
        return $this->belongsTo(Server::class);
    }

    /** @return HasMany<WebsiteDomain, $this> */
    public function domains(): HasMany
    {
        return $this->hasMany(WebsiteDomain::class);
    }

    /** @return HasOne<WebsiteSetting, $this> */
    public function settings(): HasOne
    {
        return $this->hasOne(WebsiteSetting::class);
    }
}
