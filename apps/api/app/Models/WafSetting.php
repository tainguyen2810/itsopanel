<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * WAF ModSecurity theo website (D-78): mặc định DetectionOnly.
 *
 * @property int $website_id
 * @property string $mode
 * @property int $paranoia_level
 * @property list<int> $rule_exclusions
 * @property Carbon|null $detection_since
 * @property bool $auto_block
 * @property bool $available
 * @property Carbon|null $applied_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class WafSetting extends Model
{
    protected $table = 'waf_settings';

    protected $primaryKey = 'website_id';

    public $incrementing = false;

    protected $guarded = [];

    protected $attributes = ['mode' => 'DetectionOnly', 'paranoia_level' => 1, 'rule_exclusions' => '{}',
        'auto_block' => false, 'available' => true];

    protected function casts(): array
    {
        return ['paranoia_level' => 'integer', 'detection_since' => 'datetime', 'auto_block' => 'boolean',
            'available' => 'boolean', 'applied_at' => 'datetime'];
    }

    /** @return list<int> */
    public function getRuleExclusionsAttribute(mixed $v): array
    {
        return is_string($v) ? array_values(array_map('intval', array_filter(explode(',', trim($v, '{}')), fn (string $x): bool => $x !== ''))) : [];
    }

    /** @param  list<int>  $v */
    public function setRuleExclusionsAttribute(array $v): void
    {
        $this->attributes['rule_exclusions'] = '{'.implode(',', array_map('intval', $v)).'}';
    }
}
