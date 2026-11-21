<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Khóa SSH công khai do panel quản lý (D-73): agent ghi /etc/ssh/itso_authorized_keys/<user>.
 *
 * @property int $id
 * @property string $uuid
 * @property int $hosting_account_id
 * @property string $name
 * @property string $type
 * @property string $public_key
 * @property string $fingerprint
 * @property Carbon|null $last_used_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read HostingAccount $account
 */
class SshKey extends Model
{
    use HasPublicUuid;

    protected $table = 'ssh_keys';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['last_used_at' => 'datetime'];
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id')->withTrashed();
    }
}
