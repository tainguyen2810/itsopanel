<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Nhật ký thao tác File Manager (D-72): op, đường dẫn, job, kết quả.
 *
 * @property int $id
 * @property string $uuid
 * @property int $hosting_account_id
 * @property int|null $user_id
 * @property string $op
 * @property list<string> $paths
 * @property string|null $target
 * @property string $status
 * @property int|null $job_id
 * @property string|null $error_code
 * @property Carbon $created_at
 * @property-read HostingAccount $account
 */
class FileOperation extends Model
{
    use HasPublicUuid;

    protected $table = 'file_operations';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return ['paths' => 'array', 'created_at' => 'datetime'];
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id')->withTrashed();
    }
}
