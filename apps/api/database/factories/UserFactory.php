<?php

declare(strict_types=1);

namespace Database\Factories;

use App\Models\Role;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Facades\Hash;

/**
 * Mặc định: USER realm portal, mật khẩu "password-dev-only".
 *
 * @extends Factory<User>
 */
class UserFactory extends Factory
{
    protected static ?string $password = null;

    public function definition(): array
    {
        return [
            'realm' => 'portal',
            'name' => fake()->name(),
            'email' => fake()->unique()->safeEmail(),
            'password_hash' => static::$password ??= Hash::make('password-dev-only'),
            'status' => 'active',
        ];
    }

    public function superAdmin(): static
    {
        return $this->state(['realm' => 'admin'])->withRole('SUPER_ADMIN');
    }

    public function admin(): static
    {
        return $this->state(['realm' => 'admin'])->withRole('ADMIN');
    }

    public function portalUser(): static
    {
        return $this->state(['realm' => 'portal'])->withRole('USER');
    }

    public function withRole(string $key): static
    {
        return $this->afterCreating(function (User $u) use ($key): void {
            $role = Role::query()->where('key', $key)->firstOrFail();
            $u->roles()->attach($role->id);
        });
    }
}
