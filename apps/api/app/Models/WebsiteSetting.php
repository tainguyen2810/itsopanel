<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Cấu hình Nginx/PHP của website (desired). `custom_snippet` DEFERRED (ADR 0014: không có ô cấu hình tự do).
 *
 * @property int $website_id
 * @property array<array-key, mixed> $nginx
 * @property array<array-key, mixed> $php
 * @property array<array-key, mixed> $headers
 * @property array<array-key, mixed> $waf
 * @property string|null $custom_snippet
 * @property Carbon $updated_at
 */
class WebsiteSetting extends Model
{
    public const CREATED_AT = null;

    protected $table = 'website_settings';

    protected $primaryKey = 'website_id';

    public $incrementing = false;

    protected $guarded = [];

    protected function casts(): array
    {
        return ['nginx' => 'array', 'php' => 'array', 'headers' => 'array', 'waf' => 'array'];
    }
}
