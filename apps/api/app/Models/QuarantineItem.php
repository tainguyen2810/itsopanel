<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * File trong khu cách ly của agent (/var/lib/itso/quarantine/<uuid>.bin, root 0600).
 *
 * @property int $id
 * @property string $uuid
 * @property int|null $finding_id
 * @property int|null $hosting_account_id
 * @property string $original_path
 * @property string $stored_path
 * @property string $sha256
 * @property string $signature
 * @property int $size
 * @property Carbon $quarantined_at
 * @property Carbon|null $restored_at
 * @property-read HostingAccount|null $account
 * @property-read MalwareFinding|null $finding
 */
class QuarantineItem extends Model
{
    use HasPublicUuid;

    protected $table = 'quarantine_items';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return ['size' => 'integer', 'quarantined_at' => 'datetime', 'restored_at' => 'datetime'];
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id')->withTrashed();
    }

    /** @return BelongsTo<MalwareFinding, $this> */
    public function finding(): BelongsTo
    {
        return $this->belongsTo(MalwareFinding::class, 'finding_id');
    }
}
