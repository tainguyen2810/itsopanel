<?php

declare(strict_types=1);

namespace Database\Factories;

use App\Models\Server;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<Server> */
class ServerFactory extends Factory
{
    public function definition(): array
    {
        $n = fake()->unique()->numberBetween(1, 999);

        return [
            'name' => sprintf('srv-test-%02d', $n),
            'hostname' => sprintf('srv-test-%02d.itso.local', $n),
            'ip_addresses' => [sprintf('10.0.0.%d', $n % 250 + 1)],
            'os' => 'Ubuntu 24.04 LTS',
            'accepting_new_accounts' => true,
            'status' => 'ready',
        ];
    }
}
