<?php

use App\Domain\Backup\DisasterRecovery;
use App\Models\AuditLog;
use App\Models\BackupSnapshot;
use App\Models\Database;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\RestoreJob;
use App\Models\Server;
use App\Models\User;
use App\Models\Website;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use Tests\Support\Actors;

require_once __DIR__.'/helpers.php';

// Prompt 8.5: khôi phục thảm họa: wizard (máy mới "itso install --restore") mở repo server, chạy panel.restore;
// itso:dr-restore khôi phục dữ liệu account song song có giới hạn.

/** Mã thiết lập như "itso install --restore" (file băm có mode restore). */
function p8drCode(string $mode = 'restore'): string
{
    $raw = strtoupper(strtr(Str::random(12), ['I' => 'J', 'O' => 'P', '0' => '2', '1' => '3', 'i' => 'j', 'o' => 'p', 'l' => 'm']));
    $file = sys_get_temp_dir().'/itso-setup-'.Str::random(8).'.json';
    file_put_contents($file, json_encode(['sha256' => hash('sha256', $raw), 'mode' => $mode,
        'created_at' => now()->utc()->toIso8601String(), 'expires_at' => now()->addHour()->utc()->toIso8601String()]));
    config(['itso.setup_code_file' => $file]);

    return substr($raw, 0, 4).'-'.substr($raw, 4, 4).'-'.substr($raw, 8, 4);
}

function p8drSource(array $over = []): array
{
    return $over + ['type' => 's3', 'config' => ['endpoint' => 'https://s3.example.com', 'bucket' => 'itso-backup'],
        'credentials' => ['access_key' => 'AKIAEXAMPLE1234', 'secret_key' => 'Bi-mat-S3-DR-2026!'],
        'repository_path' => 'itso/01938a02-0001-7000-8000-000002000001/server',
        'repository_password' => 'repo-panel-mat-khau-DR-2026', 'panel_private_key' => 'AGE-SECRET-KEY-1'.str_repeat('Q', 58)];
}

it('wizard khôi phục: restore_mode theo mã; inspect cần mã, liệt kê bản panel, không lưu bí mật; start → panel.restore, bí mật tạm bị xóa', function () {
    $errors = [];
    $agent = p8agent($errors, [
        'backup.snapshots' => fn () => ['snapshots' => [
            ['id' => str_repeat('a', 64), 'time' => '2026-11-08T02:31:00Z', 'tags' => ['itso', 'type:panel'], 'paths' => ['/panel'], 'hostname' => 'srv-old', 'size_bytes' => 92_000_000],
            ['id' => str_repeat('b', 64), 'time' => '2026-11-15T02:31:00Z', 'tags' => ['itso', 'type:panel'], 'paths' => ['/panel'], 'hostname' => 'srv-old', 'size_bytes' => null],
        ]],
        'panel.restore' => fn () => ['staged_dir' => '/var/lib/itso/restore/panel-20261121T080000Z', 'files' => ['itso.dump', 'etc/itso/itso.env'],
            'apply_unit' => 'itso-panel-restore-panel-20261121t080000z'],
    ]);
    Server::factory()->create();
    $spa = $this->spa('admin');
    $spa->get('/api/v1/auth/csrf')->assertNoContent();

    // Chưa xác minh mã → 403.
    assertMatchesContract(P8A, 'post', '/api/v1/admin/setup/restore:inspect', 403, $spa->call('POST', '/api/v1/admin/setup/restore:inspect', p8drSource()));

    $code = p8drCode();
    $v = $spa->call('POST', '/api/v1/admin/setup/code:verify', ['code' => $code]);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/setup/code:verify', 200, $v);
    expect($v->json('data.restore_mode'))->toBeTrue();

    // Sai trường → 422 theo trường.
    $bad = $spa->call('POST', '/api/v1/admin/setup/restore:inspect', p8drSource(['repository_path' => 'itso/x/acct-1', 'panel_private_key' => 'khong']));
    assertMatchesContract(P8A, 'post', '/api/v1/admin/setup/restore:inspect', 422, $bad);
    expect($bad->json('errors'))->toHaveKey('repository_path');
    $sftp = $spa->call('POST', '/api/v1/admin/setup/restore:inspect', p8drSource(['type' => 'sftp', 'config' => ['host' => 'bk.example.com', 'user' => 'itso', 'path' => '/srv/bk'], 'credentials' => []]));
    expect($sftp->status())->toBe(422)->and($sftp->json('errors.type.0'))->toContain('itso backup panel-restore');

    $ins = $spa->call('POST', '/api/v1/admin/setup/restore:inspect', p8drSource());
    assertMatchesContract(P8A, 'post', '/api/v1/admin/setup/restore:inspect', 200, $ins);
    expect(array_column($ins->json('data'), 'snapshot_id'))->toBe([str_repeat('b', 64), str_repeat('a', 64)])
        ->and($ins->json('data.1.size_mb'))->toBe(87.7)->and($ins->json('data.0.accounts'))->toBeNull();
    $call = collect($agent->calls)->firstWhere('op', 'backup.snapshots');
    expect($call['params']['tags'])->toBe(['type:panel'])->and($call['params']['repo']['password'])->toBe('repo-panel-mat-khau-DR-2026')
        ->and($call['params']['repo']['destination']['secret_access_key'])->toBe('Bi-mat-S3-DR-2026!');
    expect(Job::query()->count())->toBe(0)->and(p8leak('repo-panel-mat-khau-DR-2026'))->toBeNull();

    // Agent báo sai mật khẩu → 422.
    $agent->on('backup.snapshots', fn () => ['__error' => ['repo_wrong_password', 'wrong password or no key found']]);
    expect($spa->call('POST', '/api/v1/admin/setup/restore:inspect', p8drSource())->json('errors'))->toHaveKey('repository_password');

    // Start: job setup.restore, bí mật chỉ là tham chiếu; agent nhận giá trị thật; xong thì Cache bị xóa.
    $st = $spa->call('POST', '/api/v1/admin/setup/restore', ['source' => p8drSource(), 'snapshot_id' => str_repeat('b', 64)],
        ['Idempotency-Key' => (string) Str::uuid()]);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/setup/restore', 202, $st);
    expect($st->json('job.type'))->toBe('setup.restore')->and($st->json('job.state'))->toBe('succeeded');
    $pr = collect($agent->calls)->firstWhere('op', 'panel.restore');
    expect($pr['params']['age_identity'])->toBe('AGE-SECRET-KEY-1'.str_repeat('Q', 58))
        ->and($pr['params']['repo']['password'])->toBe('repo-panel-mat-khau-DR-2026')
        ->and($pr['params']['repo']['path'])->toBe('itso/01938a02-0001-7000-8000-000002000001/server');
    $redacted = JobStep::query()->where('op', 'panel.restore')->firstOrFail()->params_redacted;
    expect($redacted['age_identity'])->toHaveKey('$secret')->and($redacted['repo']['password'])->toHaveKey('$secret');
    preg_match('#setup_restore:([0-9a-f-]{36})/#', $redacted['age_identity']['$secret'], $m);
    expect(Cache::has(DisasterRecovery::cacheKey($m[1])))->toBeFalse()
        ->and(p8leak('repo-panel-mat-khau-DR-2026'))->toBeNull()->and(p8leak('Bi-mat-S3-DR-2026!'))->toBeNull()
        ->and(p8leak(str_repeat('Q', 58)))->toBeNull();
    expect(AuditLog::query()->where('action', 'setup.restore_started')->exists())->toBeTrue();
    expect($errors)->toBe([]);

    // Đã tạo SUPER_ADMIN qua wizard → 409; panel đã cài → 410.
    $spa->post('/api/v1/admin/setup/admin', ['name' => 'Quản trị', 'email' => 'root@itso.local', 'password' => 'mat-khau-rat-dai-2026'])->assertCreated();
    assertMatchesContract(P8A, 'post', '/api/v1/admin/setup/restore:inspect', 409, $spa->call('POST', '/api/v1/admin/setup/restore:inspect', p8drSource()));
    User::factory()->superAdmin()->create();
    assertMatchesContract(P8A, 'post', '/api/v1/admin/setup/restore:inspect', 410, $spa->call('POST', '/api/v1/admin/setup/restore:inspect', p8drSource()));
});

it('mã thiết lập thường: restore_mode false', function () {
    $spa = $this->spa('admin');
    $spa->get('/api/v1/auth/csrf')->assertNoContent();
    $v = $spa->call('POST', '/api/v1/admin/setup/code:verify', ['code' => p8drCode('')]);
    expect($v->json('data.restore_mode'))->toBeFalse();
});

it('itso:dr-restore: chưa bật thì không làm gì; --start khôi phục ghi đè website + DB từng account, giới hạn song song, gộp kết quả nhiều bước', function () {
    $errors = [];
    $agent = p8agent($errors);
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $u = $a->account->username;
    p8($sa, 'POST', '/api/v1/admin/backup-destinations', ['name' => 'Local', 'type' => 'local', 'config' => ['path' => '/var/backups/itso']])->assertCreated();
    Website::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id, 'primary_domain' => 'demo.vn', 'status' => 'ready']);
    Database::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id, 'engine' => 'mariadb', 'name' => "{$u}_web",
        'charset' => 'utf8mb4', 'status' => 'ready', 'size_mb' => 1]);
    p8($sa, 'POST', '/api/v1/admin/backups', ['hosting_account_uuid' => $a->account->uuid, 'contents' => ['files', 'databases']])->assertStatus(202);
    $files = BackupSnapshot::query()->where('scope_type', 'hosting_account')->firstOrFail();

    Artisan::call('itso:dr-restore');
    expect(Artisan::output())->toContain('Chưa bật')->and(RestoreJob::query()->count())->toBe(0);

    Artisan::call('itso:dr-restore', ['--start' => true, '--dry-run' => true]);
    expect(Artisan::output())->toContain('Chưa bật'); // dry-run không bật

    $before = count($agent->calls);
    Artisan::call('itso:dr-restore', ['--start' => true, '--parallel' => 1]);
    $out = Artisan::output();
    expect($out)->toContain("$u: sites/demo.vn, database:{$u}_web");
    $calls = array_slice($agent->calls, $before);
    expect(array_column($calls, 'op'))->toBe(['backup.restore', 'backup.restore'])
        ->and($calls[0]['params']['mode'])->toBe('overwrite')->and($calls[0]['params']['items'])->toBe([['kind' => 'website', 'site_dir' => 'demo.vn']])
        ->and($calls[1]['params']['items'])->toEqual([['kind' => 'database', 'db' => ['engine' => 'mariadb', 'name' => "{$u}_web"], 'target_name' => "{$u}_web"]]);
    $rj = RestoreJob::query()->firstOrFail();
    expect($rj->status)->toBe('succeeded')->and($rj->snapshot_id)->toBe($files->id)->and($rj->mode)->toBe('overwrite')
        ->and($rj->items)->toBe(['files:sites/demo.vn', "database:{$u}_web"])
        ->and($rj->result['databases'])->toBe(["{$u}_web"])->and($rj->result['restored_paths'])->toBe(['backups/restore-1121/sites/demo.vn'])
        ->and($rj->pre_restore_snapshot_id)->not->toBeNull();

    // Lượt sau: không account nào còn lại → xong; lượt nữa không xếp thêm.
    Artisan::call('itso:dr-restore');
    expect(Artisan::output())->toContain('xong');
    Artisan::call('itso:dr-restore');
    expect(Artisan::output())->toContain('đã xong')->and(RestoreJob::query()->count())->toBe(1);
    expect(AuditLog::query()->whereIn('action', ['dr.started', 'dr.account_restore', 'dr.finished'])->pluck('action')->unique()->values()->all())
        ->toBe(['dr.started', 'dr.account_restore', 'dr.finished']);
    expect($errors)->toBe([]);
});

it('khôi phục nhiều bước: một bước lỗi → restore job failed, vẫn giữ kết quả bước đã xong', function () {
    $errors = [];
    $n = 0;
    $agent = p8agent($errors, ['backup.restore' => function (array $env) use (&$n) {
        return ++$n === 1 ? ['restored_paths' => ['sites/demo.vn'], 'databases' => [], 'pre_restore_snapshot_id' => null, 'skipped' => []]
            : ['__error' => ['internal', 'mariadb không chạy']];
    }]);
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $u = $a->account->username;
    p8($sa, 'POST', '/api/v1/admin/backup-destinations', ['name' => 'Local', 'type' => 'local', 'config' => ['path' => '/var/backups/itso']])->assertCreated();
    Website::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id, 'primary_domain' => 'demo.vn', 'status' => 'ready']);
    Database::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id, 'engine' => 'mariadb', 'name' => "{$u}_web",
        'charset' => 'utf8mb4', 'status' => 'ready', 'size_mb' => 1]);
    p8($sa, 'POST', '/api/v1/admin/backups', ['hosting_account_uuid' => $a->account->uuid, 'contents' => ['files', 'databases']])->assertStatus(202);
    Artisan::call('itso:dr-restore', ['--start' => true]);
    $rj = RestoreJob::query()->firstOrFail();
    expect($rj->status)->toBe('failed')->and($rj->error)->toContain('mariadb không chạy')
        ->and($rj->result['restored_paths'])->toBe(['sites/demo.vn']);
    Artisan::call('itso:dr-restore');
    expect(Artisan::output())->toContain('1 account lỗi');
});
