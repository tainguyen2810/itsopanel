<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\PgTextArray;
use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Chứng chỉ TLS (D-69). source: acme|custom. Khóa riêng: ACME → chỉ trên agent; custom → `private_key_encrypted`.
 * status: pending|provisioning|ready|failed|deleting|expired.
 *
 * @property int $id
 * @property string $uuid
 * @property int|null $website_id
 * @property int $server_id
 * @property string|null $issuer
 * @property list<string> $domains
 * @property string $source
 * @property Carbon|null $not_before
 * @property Carbon|null $not_after
 * @property string|null $private_key_ref
 * @property string|null $private_key_encrypted
 * @property int|null $acme_account_id
 * @property bool $auto_renew
 * @property Carbon|null $last_renew_attempt_at
 * @property string|null $last_error
 * @property int $spec_version
 * @property int $observed_version
 * @property string $status
 * @property array<array-key, mixed> $observed_facts
 * @property array<array-key, mixed>|null $drift
 * @property Carbon|null $observed_at
 * @property int|null $last_job_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class Certificate extends Model
{
    use HasPublicUuid;

    protected $table = 'certificates';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id', 'private_key_encrypted'];

    protected function casts(): array
    {
        return ['domains' => PgTextArray::class, 'not_before' => 'datetime', 'not_after' => 'datetime',
            'last_renew_attempt_at' => 'datetime', 'auto_renew' => 'boolean', 'observed_facts' => 'array',
            'drift' => 'array', 'observed_at' => 'datetime'];
    }
}
