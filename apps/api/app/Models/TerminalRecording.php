<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Metadata bản ghi phiên terminal (ADR 0028). Nội dung nằm ở agent (/var/lib/itso/recordings/<uuid>.cast), panel chỉ
 * đọc qua pty.recording.read; panel không có op xóa bản ghi.
 *
 * @property int $terminal_session_id
 * @property string $mode
 * @property string|null $client_ip
 * @property string $stored_ref
 * @property int $bytes
 * @property int|null $width
 * @property int|null $height
 * @property bool $truncated
 * @property Carbon $created_at
 */
class TerminalRecording extends Model
{
    protected $table = 'terminal_recordings';

    protected $primaryKey = 'terminal_session_id';

    public $incrementing = false;

    public $timestamps = false;

    protected $guarded = [];

    protected function casts(): array
    {
        return ['bytes' => 'integer', 'width' => 'integer', 'height' => 'integer', 'truncated' => 'boolean', 'created_at' => 'datetime'];
    }
}
