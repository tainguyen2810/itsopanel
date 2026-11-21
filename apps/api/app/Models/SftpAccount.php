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
 * Tài khoản truy cập file (D-73): protocol sftp = user Linux chính của account; ftps = virtual user Pure-FTPd giới hạn thư mục con.
 *
 * @property int $id
 * @property string $uuid
 * @property int $hosting_account_id
 * @property string $username
 * @property string $root_subpath
 * @property string $protocol
 * @property string|null $password_encrypted
 * @property bool $read_only
 * @property Carbon|null $last_login_at
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
class SftpAccount extends Model
{
    use HasPublicUuid, SoftDeletes;

    protected $table = 'sftp_accounts';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id', 'password_encrypted'];

    protected function casts(): array
    {
        return ['password_encrypted' => Bytea::class, 'read_only' => 'boolean', 'last_login_at' => 'datetime', 'observed_facts' => 'array', 'drift' => 'array', 'observed_at' => 'datetime'];
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id')->withTrashed();
    }
}
