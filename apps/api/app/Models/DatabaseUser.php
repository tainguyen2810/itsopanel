<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\Bytea;
use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * DB user của account (D-71). Mật khẩu lưu mã hóa (Crypt) để đặt lại khi khôi phục/đồng bộ; tới agent chỉ qua tham chiếu bí mật.
 *
 * @property int $id
 * @property string $uuid
 * @property int $hosting_account_id
 * @property int $server_id
 * @property string $engine
 * @property string $username
 * @property string|null $password_encrypted
 * @property string $host_pattern
 * @property int $max_connections
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
 */
class DatabaseUser extends Model
{
    use HasPublicUuid, SoftDeletes;

    protected $table = 'database_users';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id', 'password_encrypted'];

    protected function casts(): array
    {
        return ['password_encrypted' => Bytea::class, 'observed_facts' => 'array', 'drift' => 'array', 'observed_at' => 'datetime'];
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id')->withTrashed();
    }
}
