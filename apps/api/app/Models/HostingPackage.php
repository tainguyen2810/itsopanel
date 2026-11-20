<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Database\Factories\HostingPackageFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Gói hosting (định danh); giới hạn nằm ở phiên bản.
 *
 * @property int $id
 * @property string $uuid
 * @property string $code
 * @property string $name
 * @property string|null $description
 * @property int $current_version
 * @property bool $is_active
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property Carbon|null $deleted_at
 */
class HostingPackage extends Model
{
    /** @use HasFactory<HostingPackageFactory> */
    use HasFactory, HasPublicUuid, SoftDeletes;

    protected $table = 'hosting_packages';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return [
            'is_active' => 'boolean',
        ];
    }

    /** @return HasMany<HostingPackageVersion, $this> */
    public function versions(): HasMany
    {
        return $this->hasMany(HostingPackageVersion::class, 'package_id');
    }
}
