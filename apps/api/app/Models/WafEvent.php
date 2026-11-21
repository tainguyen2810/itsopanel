<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Sự kiện WAF (partition theo tháng), nạp bởi itso:waf-events-sync từ waf.events của agent.
 *
 * @property int $id
 * @property string $uuid
 * @property Carbon $at
 * @property int $website_id
 * @property int $rule_id
 * @property string $severity
 * @property string $action
 * @property string|null $client_ip
 * @property string|null $method
 * @property string|null $uri
 * @property string|null $message
 */
class WafEvent extends Model
{
    protected $table = 'waf_events';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return ['at' => 'datetime', 'rule_id' => 'integer'];
    }
}
