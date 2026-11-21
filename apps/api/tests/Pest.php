<?php

use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Models\Job;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\Actors;
use Tests\Support\OpenApi;
use Tests\TestCase;

// D-59: Feature test chạy trên PostgreSQL 16, mỗi test trong transaction (RefreshDatabase).
pest()->extend(TestCase::class)->use(RefreshDatabase::class)->in('Feature');

/** Response khớp schema trong contracts/openapi (status, Content-Type, body). */
function assertMatchesContract(string $file, string $method, string $path, int $status, $response): void
{
    if ($status === 204) {
        expect(OpenApi::declares($file, $method, $path, 204))->toBeTrue("$method $path không khai báo 204")
            ->and($response->status())->toBe(204)
            ->and($response->getContent())->toBe('');

        return;
    }
    ['schema' => $schema, 'contentType' => $ct, 'file' => $ctx] = OpenApi::responseSchema($file, $method, $path, $status);
    expect($response->status())->toBe($status)
        ->and($response->headers->get('Content-Type'))->toStartWith($ct);
    // Giải mã dạng object để {} không thành [] (map rỗng như extra_headers).
    $error = OpenApi::validate($ctx, $schema, json_decode((string) $response->getContent(), false));
    expect($error)->toBeNull();
}

/** Bộ PackageLimits hợp lệ đầy đủ (ghi đè từng khóa). */
function limits(array $over = []): array
{
    return array_merge(['disk_mb' => 10240, 'inode_limit' => 200000, 'cpu_percent' => 100, 'ram_mb' => 2048, 'tasks_max' => 200,
        'php_workers_max' => 4, 'io_weight' => 100, 'io_read_bps' => null, 'io_write_bps' => null, 'website_limit' => 5,
        'alias_domain_limit' => 10, 'subdomain_limit' => 10, 'database_limit' => 5, 'db_user_limit' => 5, 'ftp_limit' => 5,
        'cron_limit' => 5, 'cron_min_interval_min' => 5, 'backup_quota_mb' => 20480,
        'backup_retention' => ['daily' => 7], 'ssh_allowed' => true, 'php_versions' => ['8.3'],
        'retention_days_after_terminate' => 30], $over);
}

/** Job 2 bước (account.suspend + quota.report) trên account mẫu, người yêu cầu là chủ account. */
function makeJob(Actors $a, ?int $timeout = 600, int $maxAttempts = 3): Job
{
    $spec = new JobSpec('account.suspend', $a->account, $a->server->id, $maxAttempts, $timeout);
    $spec->step('account.suspend', ['username' => $a->account->username, 'reason' => 'kiểm thử'])
        ->step('quota.report', ['username' => $a->account->username]);

    return app(JobDispatcher::class)->dispatch($spec, $a->owner);
}
