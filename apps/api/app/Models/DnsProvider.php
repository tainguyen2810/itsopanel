<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\Bytea;
use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * Nhà cung cấp DNS (D-70): hiện chỉ Cloudflare. `credentials_encrypted` = Crypt(JSON {api_token}) bằng APP_KEY,
 * không bao giờ trả ra API.
 *
 * @property int $id
 * @property string $uuid
 * @property string $type
 * @property string $name
 * @property string $credentials_encrypted
 * @property string|null $account_label
 * @property int|null $created_by_user_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class DnsProvider extends Model
{
    use HasPublicUuid;

    protected $table = 'dns_providers';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id', 'credentials_encrypted'];

    protected function casts(): array
    {
        return ['credentials_encrypted' => Bytea::class];
    }

    /** @return HasMany<DnsZone, $this> */
    public function zones(): HasMany
    {
        return $this->hasMany(DnsZone::class, 'provider_id');
    }
}
