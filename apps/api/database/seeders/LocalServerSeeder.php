<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Domain\Servers\ServerFacts;
use Illuminate\Database\Seeder;

/** Server local từ cấu hình (ITSO_LOCAL_SERVER=true). Không gọi agent; làm mới bằng `php artisan itso:server-local`. */
class LocalServerSeeder extends Seeder
{
    public function run(ServerFacts $facts): void
    {
        if (config('itso.local_server.enabled') === true) {
            $facts->ensureLocal();
        }
    }
}
