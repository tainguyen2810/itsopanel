<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * Zone DNS gắn với provider (Cloudflare zone id ở `external_id`), có thể gắn account hosting.
 *
 * @property int $id
 * @property string $uuid
 * @property int $provider_id
 * @property string $name
 * @property string|null $external_id
 * @property int|null $hosting_account_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read DnsProvider $provider
 * @property-read HostingAccount|null $account
 */
class DnsZone extends Model
{
    use HasPublicUuid;

    protected $table = 'dns_zones';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    /** @return BelongsTo<DnsProvider, $this> */
    public function provider(): BelongsTo
    {
        return $this->belongsTo(DnsProvider::class, 'provider_id');
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id')->withTrashed();
    }

    /** @return HasMany<DnsRecord, $this> */
    public function records(): HasMany
    {
        return $this->hasMany(DnsRecord::class, 'zone_id');
    }
}
