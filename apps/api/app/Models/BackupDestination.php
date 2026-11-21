<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\Bytea;
use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Đích backup (D-83, ADR 0030). config không bí mật; credentials_encrypted là credential GHI (Crypt JSON).
 *
 * @property int $id
 * @property string $uuid
 * @property string $name
 * @property string $type local|sftp|s3|rest
 * @property int|null $server_id
 * @property array<string, string> $config
 * @property string|null $credentials_encrypted
 * @property bool $append_only
 * @property int|null $immutable_days
 * @property array<string, mixed>|null $detected
 * @property string|null $ssh_public_key
 * @property string|null $host_key_sha256
 * @property bool $enabled
 * @property Carbon|null $last_check_at
 * @property bool|null $last_check_ok
 * @property string|null $last_check_error
 * @property Carbon|null $recovery_kit_acknowledged_at
 * @property int|null $recovery_kit_acknowledged_by_user_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property Carbon|null $deleted_at
 */
class BackupDestination extends Model
{
    use HasPublicUuid, SoftDeletes;

    protected $table = 'backup_destinations';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id', 'credentials_encrypted'];

    protected function casts(): array
    {
        return ['config' => 'array', 'credentials_encrypted' => Bytea::class, 'append_only' => 'boolean', 'detected' => 'array',
            'enabled' => 'boolean', 'last_check_at' => 'datetime', 'last_check_ok' => 'boolean', 'recovery_kit_acknowledged_at' => 'datetime'];
    }

    /** Đích bất biến (append-only hoặc Object Lock): panel không bao giờ forget/prune, chỉ CLI. */
    public function immutable(): bool
    {
        return $this->append_only || ($this->immutable_days ?? 0) > 0
            || (bool) ($this->detected['append_only'] ?? false) || ((int) ($this->detected['object_lock_days'] ?? 0)) > 0;
    }
}
