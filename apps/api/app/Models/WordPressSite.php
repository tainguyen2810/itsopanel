<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Site WordPress do Toolkit quản lý (D-99, ADR 0044). Một website có tối đa một site WordPress.
 *
 * @property int $id
 * @property string $uuid
 * @property int $website_id
 * @property int $hosting_account_id
 * @property string $path sites/<domain>/<document_root>
 * @property string|null $version
 * @property string|null $admin_user
 * @property bool $multisite
 * @property string $state ok|updating|cloning|maintenance|error
 * @property string $auto_update off|minor|all
 * @property string $update_window HH:00-HH:00
 * @property bool $maintenance
 * @property array<string, bool> $hardening
 * @property int|null $staging_of_id
 * @property bool|null $checksums_ok
 * @property int|null $database_id
 * @property Carbon|null $last_scan_at
 * @property Carbon|null $last_update_at
 * @property Carbon|null $last_auto_update_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property Carbon|null $deleted_at
 * @property-read Website $website
 * @property-read HostingAccount $account
 */
class WordPressSite extends Model
{
    use HasPublicUuid, SoftDeletes;

    protected $table = 'wordpress_sites';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['multisite' => 'boolean', 'maintenance' => 'boolean', 'hardening' => 'array', 'checksums_ok' => 'boolean',
            'last_scan_at' => 'datetime', 'last_update_at' => 'datetime', 'last_auto_update_at' => 'datetime'];
    }

    /** @return BelongsTo<Website, $this> */
    public function website(): BelongsTo
    {
        return $this->belongsTo(Website::class)->withTrashed();
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id')->withTrashed();
    }
}
