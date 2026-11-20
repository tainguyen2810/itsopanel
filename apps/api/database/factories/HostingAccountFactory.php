<?php

declare(strict_types=1);

namespace Database\Factories;

use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\Server;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/** Account active, chủ là USER portal mới, server + gói mới. @extends Factory<HostingAccount> */
class HostingAccountFactory extends Factory
{
    public function definition(): array
    {
        $username = 'acc'.fake()->unique()->numberBetween(1000, 99999);

        return [
            'server_id' => Server::factory(),
            'package_version_id' => fn () => HostingPackage::factory()->create()->versions()->firstOrFail()->id,
            'owner_user_id' => User::factory()->portalUser(),
            'username' => $username,
            'uid' => fake()->unique()->numberBetween(20000, 59999),
            'home_path' => '/home/'.$username,
            'lifecycle_state' => 'active',
            'status' => 'ready',
        ];
    }
}
