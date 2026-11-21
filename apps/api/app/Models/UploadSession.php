<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Phiên upload kiểu tus (D-72): chunk ghi vào thư mục staging, commit qua job fs.upload.commit.
 *
 * @property int $id
 * @property string $uuid
 * @property int $user_id
 * @property int $hosting_account_id
 * @property string $target_path
 * @property int $size_bytes
 * @property int $received_bytes
 * @property bool $overwrite
 * @property string $status
 * @property int|null $job_id
 * @property Carbon $expires_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read HostingAccount $account
 */
class UploadSession extends Model
{
    use HasPublicUuid;

    protected $table = 'upload_sessions';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['overwrite' => 'boolean', 'expires_at' => 'datetime'];
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id')->withTrashed();
    }
}
