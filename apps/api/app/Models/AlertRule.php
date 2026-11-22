<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Rule cảnh báo (D-102, ADR 0047): `metric operator threshold` kéo dài `duration_sec` trên phạm vi
 * server | hosting_account | website (scope_id null = mọi đối tượng cùng loại). Rule mặc định có `default_key`.
 *
 * @property int $id
 * @property string $uuid
 * @property string $name
 * @property string $metric
 * @property string $operator gt|gte|lt|lte
 * @property float $threshold
 * @property int $duration_sec
 * @property int $repeat_sec
 * @property string $severity low|medium|high|critical
 * @property string $scope_type
 * @property int|null $scope_id
 * @property list<string> $channels
 * @property list<int> $channel_ids
 * @property bool $is_default
 * @property string|null $default_key
 * @property bool $enabled
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class AlertRule extends Model
{
    use HasPublicUuid;

    protected $table = 'alert_rules';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['threshold' => 'float', 'is_default' => 'boolean', 'enabled' => 'boolean', 'duration_sec' => 'integer',
            'repeat_sec' => 'integer', 'scope_id' => 'integer'];
    }

    /** @return list<string> */
    public function getChannelsAttribute(?string $v): array
    {
        return self::pgArray($v);
    }

    /** @param  list<string>  $v */
    public function setChannelsAttribute(array $v): void
    {
        $this->attributes['channels'] = '{'.implode(',', $v).'}';
    }

    /** @return list<int> */
    public function getChannelIdsAttribute(?string $v): array
    {
        return array_map('intval', self::pgArray($v));
    }

    /** @param  list<int>  $v */
    public function setChannelIdsAttribute(array $v): void
    {
        $this->attributes['channel_ids'] = '{'.implode(',', array_map('intval', $v)).'}';
    }

    /** @return list<string> mảng text[] của PostgreSQL (phần tử chỉ chữ/số/_ nên không cần giải mã ngoặc kép) */
    private static function pgArray(?string $v): array
    {
        $v = trim((string) $v, '{}');

        return $v === '' ? [] : array_map(fn (string $s): string => trim($s, '"'), explode(',', $v));
    }
}
