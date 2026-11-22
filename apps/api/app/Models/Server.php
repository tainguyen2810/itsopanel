<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\PgTextArray;
use App\Models\Concerns\HasPublicUuid;
use Database\Factories\ServerFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Máy chủ do panel quản lý.
 *
 * @property int $id
 * @property string $uuid
 * @property string $name
 * @property string $hostname
 * @property string $node_role all_in_one|control_plane|node (Phase 9, D-88)
 * @property array<array-key, mixed> $ip_addresses
 * @property list<string> $role_tags
 * @property string|null $os
 * @property string|null $kernel
 * @property bool $accepting_new_accounts
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
class Server extends Model
{
    /** @use HasFactory<ServerFactory> */
    use HasFactory, HasPublicUuid, SoftDeletes;

    protected $table = 'servers';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return [
            'role_tags' => PgTextArray::class,
            'ip_addresses' => 'array',
            'observed_facts' => 'array',
            'drift' => 'array',
            'accepting_new_accounts' => 'boolean',
            'observed_at' => 'datetime',
        ];
    }

    /** @return HasOne<Agent, $this> */
    public function agent(): HasOne
    {
        return $this->hasOne(Agent::class, 'server_id');
    }

    /** @return HasMany<HostingAccount, $this> */
    public function hostingAccounts(): HasMany
    {
        return $this->hasMany(HostingAccount::class, 'server_id');
    }
}
