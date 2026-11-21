<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Bản ghi DNS. `name` tương đối với zone (`@` = gốc). `external_id` = id bản ghi phía Cloudflare.
 *
 * @property int $id
 * @property string $uuid
 * @property int $zone_id
 * @property string $type
 * @property string $name
 * @property string $content
 * @property int $ttl
 * @property int|null $priority
 * @property bool $proxied
 * @property string|null $external_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class DnsRecord extends Model
{
    use HasPublicUuid;

    protected $table = 'dns_records';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['ttl' => 'integer', 'priority' => 'integer', 'proxied' => 'boolean'];
    }
}
