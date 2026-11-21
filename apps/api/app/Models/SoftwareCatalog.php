<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\PgTextArray;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Danh mục phần mềm cài được qua recipe của agent (defs Recipe). Seed bởi SoftwareCatalogSeeder.
 *
 * @property int $id
 * @property string $key
 * @property string $name
 * @property string $category
 * @property array<array-key, mixed> $versions
 * @property list<string> $conflicts
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class SoftwareCatalog extends Model
{
    protected $table = 'software_catalog';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['versions' => 'array', 'conflicts' => PgTextArray::class];
    }
}
