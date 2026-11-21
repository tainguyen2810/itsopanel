<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Tài khoản ACME theo server + email + directory (D-69). Khóa tài khoản giữ trên máy (`key_location='agent'`),
 * lego tự tạo ở /etc/itso/acme/<directory>; panel chỉ ghi nhận.
 *
 * @property int $id
 * @property int $server_id
 * @property string $email
 * @property string $directory_url
 * @property string $key_location
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class AcmeAccount extends Model
{
    protected $table = 'acme_accounts';

    protected $guarded = ['id'];

    protected $hidden = ['key_encrypted'];
}
