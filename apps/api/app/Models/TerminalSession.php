<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Phiên terminal USER (D-75): ghi khi panel cấp ticket; ended_at/ended_reason do itso:terminal-reap đặt
 * (agent đóng phiên sau 15 phút nhàn rỗi hoặc 12 giờ).
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

    protected function casts(): array
    {
        return ['started_at' => 'datetime', 'ended_at' => 'datetime'];
    }
}
