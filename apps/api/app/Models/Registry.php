<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\Bytea;
use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Registry image riêng (D-98). Mật khẩu chỉ lưu Crypt; tới agent qua secret_ref `registry_password:<uuid>`.
 *
 * @property int $id
 * @property string $uuid
 * @property string $name
 * @property string $url
 * @property string|null $username
 * @property string|null $password_encrypted
 * @property Carbon|null $last_test_at
 * @property bool|null $last_test_ok
 * @property string|null $last_test_message
 * @property int|null $created_by_user_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property Carbon|null $deleted_at
 */
class Registry extends Model
{
    use HasPublicUuid, SoftDeletes;

    protected $table = 'registries';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id', 'password_encrypted'];

    protected function casts(): array
    {
        return ['password_encrypted' => Bytea::class, 'last_test_at' => 'datetime', 'last_test_ok' => 'boolean'];
    }

    /** Host registry (khớp RegistryHost của agent): `https://ghcr.io/x` → `ghcr.io`. */
    public function host(): string
    {
        $h = (string) parse_url($this->url, PHP_URL_HOST);
        $p = parse_url($this->url, PHP_URL_PORT);

        return strtolower($h).(is_int($p) ? ':'.$p : '');
    }
}
