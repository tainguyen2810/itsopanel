<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Database\Factories\HostingAccountFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Tài khoản hosting. Mọi thay đổi đi qua Hosting Provisioning Service (D-49).
 *
 * @property int $id
 * @property string $uuid
 * @property int $server_id
 * @property int $package_version_id
 * @property int $owner_user_id
 * @property string $username
 * @property int $uid
 * @property string $home_path
 * @property string $lifecycle_state
 * @property string|null $suspended_reason
 * @property array<array-key, mixed> $limits_override
 * @property Carbon|null $terminated_at
 * @property Carbon|null $purge_after
 * @property bool $legal_hold
 * @property int|null $migrated_from_account_id
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
 */
class HostingAccount extends Model
{
    /** @use HasFactory<HostingAccountFactory> */
    use HasFactory, HasPublicUuid, SoftDeletes;

    protected $table = 'hosting_accounts';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return [
            'limits_override' => 'array',
            'observed_facts' => 'array',
            'drift' => 'array',
            'legal_hold' => 'boolean',
            'terminated_at' => 'datetime',
            'purge_after' => 'datetime',
            'observed_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<Server, $this> */
    public function server(): BelongsTo
    {
        return $this->belongsTo(Server::class, 'server_id');
    }

    /** @return BelongsTo<HostingPackageVersion, $this> */
    public function packageVersion(): BelongsTo
    {
        return $this->belongsTo(HostingPackageVersion::class, 'package_version_id');
    }

    /** @return BelongsTo<User, $this> */
    public function owner(): BelongsTo
    {
        return $this->belongsTo(User::class, 'owner_user_id');
    }

    /** @return HasMany<AccountLifecycleEvent, $this> */
    public function lifecycleEvents(): HasMany
    {
        return $this->hasMany(AccountLifecycleEvent::class, 'hosting_account_id');
    }
}
