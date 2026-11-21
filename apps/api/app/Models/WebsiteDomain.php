<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Domain của website (bảng `domains`). type: primary|alias|redirect|subdomain. Tên duy nhất khi còn hoạt động.
 *
 * @property int $id
 * @property string $uuid
 * @property int $website_id
 * @property string $name
 * @property string $type
 * @property Carbon|null $verified_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property Carbon|null $deleted_at
 * @property-read Website $website
 */
class WebsiteDomain extends Model
{
    use HasPublicUuid, SoftDeletes;

    protected $table = 'domains';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['verified_at' => 'datetime'];
    }

    /** @return BelongsTo<Website, $this> */
    public function website(): BelongsTo
    {
        return $this->belongsTo(Website::class)->withTrashed();
    }
}
