<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Cache wp.info: core, plugin, theme và bản mới.
 *
 * @property int $id
 * @property int $wordpress_site_id
 * @property string $type core|plugin|theme
 * @property string|null $slug
 * @property string $name
 * @property string $version
 * @property string|null $update_version
 * @property bool $active
 * @property Carbon $observed_at
 */
class WordPressComponent extends Model
{
    public $timestamps = false;

    protected $table = 'wordpress_components';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['active' => 'boolean', 'observed_at' => 'datetime'];
    }
}
