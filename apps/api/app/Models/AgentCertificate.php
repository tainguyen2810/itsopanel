<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Lịch sử chứng chỉ mTLS của node + nguồn danh sách thu hồi cho itso-relay (D-89, D-90).
 *
 * @property int $id
 * @property int $server_id
 * @property string $serial
 * @property string $fingerprint_sha256
 * @property Carbon $not_before
 * @property Carbon $not_after
 * @property string $issued_reason enroll|rotate|rejoin
 * @property Carbon|null $revoked_at
 * @property string|null $revoked_reason revoke|superseded|rejoin
 * @property Carbon $created_at
 */
class AgentCertificate extends Model
{
    public const UPDATED_AT = null;

    protected $table = 'agent_certificates';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['not_before' => 'datetime', 'not_after' => 'datetime', 'revoked_at' => 'datetime'];
    }
}
