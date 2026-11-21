<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Desired state bảo mật theo máy chủ (sshd, fail2ban) + kết quả security.audit / điểm gần nhất.
 *
 * @property int $server_id
 * @property array<string, mixed> $ssh
 * @property array<string, mixed> $fail2ban
 * @property array<string, mixed>|null $audit_facts
 * @property Carbon|null $audited_at
 * @property int|null $score
 * @property list<array<string, mixed>>|null $score_items
 * @property Carbon|null $scored_at
 * @property Carbon|null $fim_baseline_at
 * @property Carbon|null $fim_checked_at
 * @property string|null $waf_events_cursor
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class SecuritySetting extends Model
{
    protected $table = 'security_settings';

    protected $primaryKey = 'server_id';

    public $incrementing = false;

    protected $guarded = [];

    protected $attributes = ['ssh' => '{}', 'fail2ban' => '{}'];

    protected function casts(): array
    {
        return ['ssh' => 'array', 'fail2ban' => 'array', 'audit_facts' => 'array', 'audited_at' => 'datetime',
            'score' => 'integer', 'score_items' => 'array', 'scored_at' => 'datetime', 'fim_baseline_at' => 'datetime',
            'fim_checked_at' => 'datetime'];
    }

    public static function for(int $serverId): self
    {
        /** @var self */
        return self::query()->firstOrCreate(['server_id' => $serverId]);
    }
}
