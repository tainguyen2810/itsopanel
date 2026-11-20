<?php

namespace Tests;

use App\Auth\Realm;
use Database\Seeders\DatabaseSeeder;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Tests\Support\Spa;

abstract class TestCase extends BaseTestCase
{
    /** RefreshDatabase chạy seeder nền (vai trò) sau migrate. */
    protected bool $seed = true;

    protected string $seeder = DatabaseSeeder::class;

    /** Trình duyệt giả cho SPA của realm (cookie + CSRF như thật). */
    public function spa(string $realm = Realm::PORTAL, string $ip = '127.0.0.1'): Spa
    {
        return new Spa($this, $realm, $ip);
    }
}
