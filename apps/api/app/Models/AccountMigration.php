<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Lượt chuyển account giữa server (D-93, ADR 0038): preflight → syncing → verifying → cutover → holding → completed,
 * nhánh rolled_back / failed. Mỗi account chỉ một lượt chưa kết thúc (unique index một phần).
 *
 * @property int $id
 * @property string $uuid
 * @property int $hosting_account_id
 * @property int $source_server_id
 * @property int $target_server_id
 * @property int|null $target_account_id
 * @property string $state
 * @property int $keep_source_days
 * @property list<array{kind: string, name: string, ok: bool, detail: string}> $verification
 * @property array<string, mixed>|null $preflight
 * @property array{mode: string, zone: string|null, records: list<array<string, string>>, switched?: bool}|null $dns
 * @property string|null $sync_snapshot_id
 * @property string|null $final_snapshot_id
 * @property int $bytes_synced
 * @property int|null $downtime_estimate_sec
 * @property int|null $downtime_sec
 * @property int|null $job_id
 * @property Carbon|null $cutover_at
 * @property Carbon|null $cleanup_after
 * @property Carbon|null $cleaned_at
 * @property string|null $error
 * @property int $requested_by_user_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read HostingAccount $account
 * @property-read Server $source
 * @property-read Server $target
 */
class AccountMigration extends Model
{
    public const OPEN = ['preflight', 'syncing', 'verifying', 'cutover', 'holding'];

    protected $table = 'account_migrations';

    protected $guarded = ['id', 'uuid'];

    protected function casts(): array
    {
        return ['verification' => 'array', 'preflight' => 'array', 'dns' => 'array', 'cutover_at' => 'datetime',
            'cleanup_after' => 'datetime', 'cleaned_at' => 'datetime', 'bytes_synced' => 'integer'];
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id');
    }

    /** @return BelongsTo<Server, $this> */
    public function source(): BelongsTo
    {
        return $this->belongsTo(Server::class, 'source_server_id');
    }

    /** @return BelongsTo<Server, $this> */
    public function target(): BelongsTo
    {
        return $this->belongsTo(Server::class, 'target_server_id');
    }
}
