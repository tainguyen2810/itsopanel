<?php

declare(strict_types=1);

namespace Database\Factories;

use App\Models\HostingPackage;
use App\Models\HostingPackageVersion;
use Illuminate\Database\Eloquent\Factories\Factory;

/** Gói kèm phiên bản 1. @extends Factory<HostingPackage> */
class HostingPackageFactory extends Factory
{
    public function definition(): array
    {
        return [
            'code' => 'pkg'.fake()->unique()->numberBetween(100, 99999),
            'name' => 'Gói thử',
            'current_version' => 1,
            'is_active' => true,
        ];
    }

    public function configure(): static
    {
        return $this->afterCreating(function (HostingPackage $p): void {
            HostingPackageVersion::factory()->create(['package_id' => $p->id, 'version' => 1]);
        });
    }
}
