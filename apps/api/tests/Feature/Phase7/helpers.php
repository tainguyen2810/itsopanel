<?php

// Hàm dùng chung cho test Phase 7 (không phải file test: tên không kết thúc bằng Test.php).

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\Spa;

if (! defined('P7A')) {
    define('P7A', 'itso-admin-v1.yaml');
    define('P7P', 'itso-portal-v1.yaml');
    define('P7TOKEN', 'tok_c2FmZS1hcHBseS10b2tlbi10ZXN0LW9ubHktMzJieXRlcw');
}

function p7(Spa $spa, string $method, string $uri, array $body = [], array $headers = []): TestResponse
{
    return $spa->call($method, $uri, $body, $headers + ['Idempotency-Key' => (string) Str::uuid()]);
}

function p7leak(string $secret): ?string
{
    foreach (['job_steps', 'job_logs', 'audit_logs', 'jobs', 'firewall_applies'] as $t) {
        if (DB::table($t)->get()->contains(fn ($row) => str_contains(json_encode($row), $secret))) {
            return $t;
        }
    }

    return null;
}
