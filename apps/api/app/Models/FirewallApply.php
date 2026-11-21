<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Một lần safe-apply (tường lửa hoặc sshd, D-76/D-77). Chỉ lưu sha256 của token xác nhận.
 *
 * @property int $id
 * @property string $uuid
 * @property int $server_id
 * @property string $target
 * @property int|null $user_id
 * @property string $client_ip
 * @property string|null $token_hash
 * @property array<string, mixed> $spec
 * @property array<string, mixed>|null $previous
 * @property string|null $ruleset_sha256
 * @property string $status
 * @property Carbon $deadline_at
 * @property Carbon|null $confirmed_at
 * @property Carbon|null $rolled_back_at
 * @property int|null $job_id
 * @property Carbon $created_at
 * @property-read User|null $user
 */
class FirewallApply extends Model
{
    use HasPublicUuid;

    protected $table = 'firewall_applies';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id', 'token_hash'];

    public $timestamps = false;

    protected function casts(): array
    {
        return ['spec' => 'array', 'previous' => 'array', 'deadline_at' => 'datetime', 'confirmed_at' => 'datetime',
            'rolled_back_at' => 'datetime', 'created_at' => 'datetime'];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
