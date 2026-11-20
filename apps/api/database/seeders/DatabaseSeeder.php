<?php

declare(strict_types=1);

namespace Database\Seeders;

use Illuminate\Database\Seeder;

/** Dữ liệu nền bắt buộc (không có dữ liệu mẫu; dữ liệu demo: DemoSeeder, Prompt 3.6). */
class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        $this->call(RoleSeeder::class);
    }
}
