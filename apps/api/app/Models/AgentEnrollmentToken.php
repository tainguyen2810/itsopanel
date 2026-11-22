<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\PgTextArray;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Token join node dùng một lần (D-90). DB chỉ lưu sha256 của token.
 *
 * @property int $id
 * @property string $uuid
 * @property string $token_hash
 * @property string $server_name
 * @property list<string> $role_tags
 * @property int $created_by_user_id
 * @property Carbon $expires_at
 * @property Carbon|null $used_at
 * @property int|null $used_by_server_id
 * @property string|null $used_from_ip
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class AgentEnrollmentToken extends Model
{
    protected $table = 'agent_enrollment_tokens';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['token_hash'];

    protected function casts(): array
    {
        return ['expires_at' => 'datetime', 'used_at' => 'datetime', 'role_tags' => PgTextArray::class];
    }
}
