<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Support\Carbon;

/**
 * Người dùng. `realm` admin (SUPER_ADMIN/ADMIN) hoặc portal (USER), bất biến sau khi tạo (trigger DB).
 *
 * @property int $id
 * @property string $uuid
 * @property string $realm
 * @property string $name
 * @property string $email
 * @property string $password_hash
 * @property string $locale
 * @property string $timezone
 * @property string $status
 * @property bool $must_change_password
 * @property int|null $created_by_user_id
 * @property Carbon|null $last_login_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasFactory, HasPublicUuid;

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id', 'password_hash'];

    /** Bảng không có cột remember_token (phiên lưu ở bảng sessions). */
    protected $rememberTokenName = '';

    protected function casts(): array
    {
        return [
            'must_change_password' => 'boolean',
            'last_login_at' => 'datetime',
        ];
    }

    public function getAuthPassword(): string
    {
        return $this->password_hash;
    }

    public function getAuthPasswordName(): string
    {
        return 'password_hash';
    }

    /** @return BelongsToMany<Role, $this> */
    public function roles(): BelongsToMany
    {
        return $this->belongsToMany(Role::class, 'user_roles')->withTimestamps();
    }

    /** @return HasMany<UserScope, $this> */
    public function scopes(): HasMany
    {
        return $this->hasMany(UserScope::class);
    }

    /** @return HasMany<MfaCredential, $this> */
    public function mfaCredentials(): HasMany
    {
        return $this->hasMany(MfaCredential::class);
    }

    /** @return HasMany<HostingAccount, $this> */
    public function hostingAccounts(): HasMany
    {
        return $this->hasMany(HostingAccount::class, 'owner_user_id');
    }

    /** Vai trò duy nhất (v0.x: 1 vai trò/user — unique user_roles.user_id). */
    public function roleKey(): ?string
    {
        /** @var Role|null $r */
        $r = $this->roles->first();

        return $r?->key;
    }
}
