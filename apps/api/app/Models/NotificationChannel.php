<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;

/**
 * Kênh thông báo realm admin (D-103): email nhóm, Telegram, webhook. Bí mật lưu Crypt, chỉ ghi.
 *
 * @property int $id
 * @property string $uuid
 * @property string $type
 * @property string $name
 * @property array<string, mixed> $config
 * @property string|null $secret_encrypted
 * @property bool $enabled
 * @property int|null $created_by_user_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class NotificationChannel extends Model
{
    protected $table = 'notification_channels';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id', 'secret_encrypted'];

    protected function casts(): array
    {
        return ['config' => 'array', 'enabled' => 'boolean'];
    }

    public function secret(): ?string
    {
        return $this->secret_encrypted === null ? null : Crypt::decryptString($this->secret_encrypted);
    }

    public function setSecret(?string $secret): void
    {
        $this->secret_encrypted = $secret === null ? null : Crypt::encryptString($secret);
    }
}
