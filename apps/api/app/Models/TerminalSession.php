<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Support\Carbon;

/**
 * Phiên terminal (D-75, ADR 0028): mode account (USER/ADMIN) hoặc root (SUPER_ADMIN, Phase 7); ghi khi panel cấp
 * ticket; ended_at/ended_reason do itso:terminal-reap đặt theo pty.list (phiên không còn ở agent).
 *
 * @property int $id
 * @property string $uuid
 * @property int $user_id
 * @property int $server_id
 * @property int|null $hosting_account_id
 * @property int $unix_uid
 * @property string $mode
 * @property Carbon $started_at
 * @property Carbon|null $ended_at
 * @property string|null $ended_reason
 * @property string|null $recording_ref
 */
class TerminalSession extends Model
{
    use HasPublicUuid;

    protected $table = 'terminal_sessions';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    public $timestamps = false;

    /** @return HasOne<TerminalRecording, $this> */
    public function recording(): HasOne
    {
        return $this->hasOne(TerminalRecording::class, 'terminal_session_id');
    }

    /** @return BelongsTo<Server, $this> */
    public function server(): BelongsTo
    {
        return $this->belongsTo(Server::class);
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function hostingAccount(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class)->withTrashed();
    }

    protected function casts(): array
    {
        return ['started_at' => 'datetime', 'ended_at' => 'datetime'];
    }
}
