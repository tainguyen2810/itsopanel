<?php

use App\Models\CronJob;
use App\Models\CronRun;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\FileOperation;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\SftpAccount;
use App\Models\SshKey;
use App\Models\UploadSession;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;
use Tests\Support\Spa;

// Prompt 6.3: API dữ liệu hosting (database, SFTP/FTPS, khóa SSH, cron, File Manager) qua admin và portal.

const D6A = 'itso-admin-v1.yaml';
const D6P = 'itso-portal-v1.yaml';
const D6KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test@itso';

function d6(Spa $spa, string $method, string $uri, array $body = [], array $headers = []): TestResponse
{
    return $spa->call($method, $uri, $body, $headers + ['Idempotency-Key' => (string) Str::uuid()]);
}

function d6agent(array $over = []): FakeAgent
{
    return new FakeAgent($over + [
        'fs.list' => fn () => ['path' => '.', 'entries' => [
            ['name' => 'sites', 'type' => 'dir', 'size' => 4096, 'mode' => '0755', 'modified_at' => '2026-11-20T08:00:00Z'],
            ['name' => 'notes.txt', 'type' => 'file', 'size' => 12, 'mode' => '0644', 'modified_at' => '2026-11-20T08:00:00Z'],
            ['name' => 'big.log', 'type' => 'file', 'size' => 900, 'mode' => '0640', 'modified_at' => '2026-11-20T09:00:00Z'],
        ], 'truncated' => false],
        'fs.stat' => fn () => ['exists' => true, 'type' => 'file', 'size' => 12, 'mode' => '0644', 'modified_at' => '2026-11-20T08:00:00Z'],
        'fs.read' => fn (array $env) => ['content_b64' => base64_encode(substr('xin chao itso', (int) ($env['params']['offset'] ?? 0), 12)),
            'sha256' => hash('sha256', 'xin chao its'), 'truncated' => false],
        '*' => fn () => ['ok' => true],
    ]);
}

function d6ops(FakeAgent $agent): array
{
    return array_values(array_filter($agent->ops(), fn (string $o): bool => $o !== 'fs.stat'));
}

function d6secretLeaked(string $secret): ?string
{
    foreach (['job_steps', 'job_logs', 'audit_logs', 'jobs'] as $t) {
        if (DB::table($t)->get()->contains(fn ($row) => str_contains(json_encode($row), $secret))) {
            return $t;
        }
    }

    return null;
}

beforeEach(function () {
    $dir = sys_get_temp_dir().'/itso-uploads-'.Str::random(8);
    config(['itso.files.upload_dir' => $dir]);
});

it('database: tạo kèm user (mật khẩu trả một lần, không lộ trong job/audit), quyền, đổi mật khẩu, export/import, xóa; khớp hợp đồng admin + portal', function () {
    $agent = d6agent();
    $a = new Actors($this);
    $u = $a->account->username;
    $in = $a->spa('AD_IN');

    $r = d6($in, 'POST', '/api/v1/admin/databases', ['hosting_account_uuid' => $a->account->uuid, 'engine' => 'mysql',
        'name' => "{$u}_web", 'create_user' => true]);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/databases', 202, $r);
    $secret = (string) $r->json('secret');
    expect($r->json('job.type'))->toBe('database.create')->and($r->json('resource.type'))->toBe('database')
        ->and($secret)->toMatch('/^[A-Za-z0-9._~!@#%^*+=:,-]{20,}$/')
        ->and($r->headers->get('Cache-Control'))->toContain('no-store')
        ->and($agent->ops())->toBe(['db.mysql.owner_ensure', 'db.mysql.create', 'db.mysql.user_ensure', 'db.mysql.grant']);
    // Agent nhận mật khẩu thật (đã giải tham chiếu); job_steps chỉ giữ tham chiếu.
    expect($agent->calls[2]['params']['password'])->toBe($secret)
        ->and(d6secretLeaked($secret))->toBeNull();
    $step = JobStep::query()->where('op', 'db.mysql.user_ensure')->firstOrFail();
    expect($step->params_redacted['password'])->toHaveKey('$secret');
    $db = Database::query()->where('name', "{$u}_web")->firstOrFail();
    $user = DatabaseUser::query()->where('username', "{$u}_web")->firstOrFail();
    expect($db->engine)->toBe('mariadb')->and($db->status)->toBe('ready')->and($user->status)->toBe('ready')
        ->and($user->password_encrypted)->not->toContain($secret);

    $id = $db->uuid;
    $show = $in->get("/api/v1/admin/databases/$id");
    assertMatchesContract(D6A, 'get', '/api/v1/admin/databases/{id}', 200, $show);
    expect($show->json('data.users'))->toBe(["{$u}_web"])->and($show->headers->get('ETag'))->not->toBeNull();
    assertMatchesContract(D6A, 'get', '/api/v1/admin/databases', 200, $in->get('/api/v1/admin/databases?q=web'));
    $users = $in->get('/api/v1/admin/database-users?filter[hosting_account]='.$a->account->uuid);
    assertMatchesContract(D6A, 'get', '/api/v1/admin/database-users', 200, $users);
    expect($users->json('data.0.grants'))->toBe([['database' => "{$u}_web", 'privileges' => ['ALL']]]);

    // User thứ hai do người dùng đặt mật khẩu → không trả secret.
    $u2 = d6($in, 'POST', '/api/v1/admin/database-users', ['hosting_account_uuid' => $a->account->uuid, 'engine' => 'mariadb',
        'username' => "{$u}_ro", 'password' => 'Mat-khau-du-dai-2026']);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/database-users', 202, $u2);
    expect($u2->json('secret'))->toBeNull()->and(d6secretLeaked('Mat-khau-du-dai-2026'))->toBeNull();
    $ro = DatabaseUser::query()->where('username', "{$u}_ro")->firstOrFail();
    $g = d6($in, 'PUT', "/api/v1/admin/database-users/{$ro->uuid}/grants", ['grants' => [['database' => "{$u}_web", 'privileges' => ['SELECT']]]]);
    assertMatchesContract(D6A, 'put', '/api/v1/admin/database-users/{id}/grants', 202, $g);
    expect(collect($agent->calls)->last()['op'])->toBe('db.mysql.grant')
        ->and(collect($agent->calls)->last()['params'])->toMatchArray(['username' => "{$u}_ro", 'database' => "{$u}_web", 'privileges' => ['SELECT']]);
    $bad = d6($in, 'PUT', "/api/v1/admin/database-users/{$ro->uuid}/grants", ['grants' => [['database' => "{$u}_web", 'privileges' => ['SUPER']]]]);
    assertMatchesContract(D6A, 'put', '/api/v1/admin/database-users/{id}/grants', 422, $bad);

    $rot = $in->post("/api/v1/admin/database-users/{$ro->uuid}:rotate-password");
    assertMatchesContract(D6A, 'post', '/api/v1/admin/database-users/{id}:rotate-password', 200, $rot);
    expect(d6secretLeaked((string) $rot->json('data.secret')))->toBeNull()
        ->and(collect($agent->calls)->last()['params']['password'])->toBe($rot->json('data.secret'));

    $ex = d6($in, 'POST', "/api/v1/admin/databases/$id:export");
    assertMatchesContract(D6A, 'post', '/api/v1/admin/databases/{id}:export', 202, $ex);
    expect(array_slice($agent->ops(), -2))->toBe(['fs.mkdir', 'db.mysql.dump']);
    $im = d6($in, 'POST', "/api/v1/admin/databases/$id:import", ['path' => 'backups/web.sql.gz']);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/databases/{id}:import', 202, $im);
    expect(collect($agent->calls)->last())->op->toBe('db.mysql.import');
    expect(d6($in, 'POST', "/api/v1/admin/databases/$id:import", ['path' => '../etc/passwd'])->status())->toBe(422);

    // Portal: chủ account xem + tạo PostgreSQL; xóa cần step-up (USER chưa xác thực lại → 403).
    $owner = $a->spa('US_OWNER');
    assertMatchesContract(D6P, 'get', '/api/v1/portal/databases', 200, $owner->get('/api/v1/portal/databases'));
    assertMatchesContract(D6P, 'get', '/api/v1/portal/databases/{id}', 200, $owner->get("/api/v1/portal/databases/$id"));
    assertMatchesContract(D6P, 'get', '/api/v1/portal/database-users', 200, $owner->get('/api/v1/portal/database-users'));
    $pg = d6($owner, 'POST', '/api/v1/portal/databases', ['hosting_account_uuid' => $a->account->uuid, 'engine' => 'postgresql', 'name' => "{$u}_pg"]);
    assertMatchesContract(D6P, 'post', '/api/v1/portal/databases', 202, $pg);
    expect($pg->json('secret'))->toBeNull()->and(array_slice($agent->ops(), -2))->toBe(['db.pg.owner_ensure', 'db.pg.create']);
    $pdel = d6($owner, 'DELETE', "/api/v1/portal/databases/$id");
    expect($pdel->status())->toBe(403);
    // Người ngoài phạm vi → 404.
    expect($a->spa('AD_OUT')->get("/api/v1/admin/databases/$id")->status())->toBe(404)
        ->and($a->spa('US_OTHER')->get("/api/v1/portal/databases/$id")->status())->toBe(404);

    $du = d6($in, 'DELETE', "/api/v1/admin/database-users/{$ro->uuid}");
    assertMatchesContract(D6A, 'delete', '/api/v1/admin/database-users/{id}', 202, $du);
    $del = d6($in, 'DELETE', "/api/v1/admin/databases/$id");
    assertMatchesContract(D6A, 'delete', '/api/v1/admin/databases/{id}', 202, $del);
    expect(collect($agent->calls)->last())->op->toBe('db.mysql.drop')
        ->and(Database::query()->where('uuid', $id)->exists())->toBeFalse()
        ->and(Database::withTrashed()->where('uuid', $id)->exists())->toBeTrue()
        ->and(DB::table('database_grants')->where('database_id', $db->id)->count())->toBe(0);
});

it('database: tên sai/không có tiền tố/chèn SQL, trường lạ, PG host %, vượt database_limit → 422', function () {
    d6agent();
    $a = new Actors($this);
    $u = $a->account->username;
    $sa = $a->spa('SA');
    $mk = fn (array $b) => d6($sa, 'POST', '/api/v1/admin/databases', $b + ['hosting_account_uuid' => $a->account->uuid, 'engine' => 'mysql']);
    foreach (['web', "{$u}_", "{$u}_web'; DROP DATABASE x; --", "{$u}_Web", 'mysql', "other_{$u}", str_repeat('a', 70)] as $bad) {
        $r = $mk(['name' => $bad]);
        expect($r->status())->toBe(422, $bad)->and($r->json('errors'))->toHaveKey('name');
    }
    assertMatchesContract(D6A, 'post', '/api/v1/admin/databases', 422, $mk(['name' => "{$u}_web", 'rogue' => 1]));
    expect($mk(['name' => "{$u}_web", 'engine' => 'oracle'])->status())->toBe(422);
    $pgu = d6($sa, 'POST', '/api/v1/admin/database-users', ['hosting_account_uuid' => $a->account->uuid, 'engine' => 'postgresql',
        'username' => "{$u}_app", 'host' => '%']);
    expect($pgu->status())->toBe(422)->and($pgu->json('errors'))->toHaveKey('host');
    $weak = d6($sa, 'POST', '/api/v1/admin/database-users', ['hosting_account_uuid' => $a->account->uuid, 'engine' => 'mysql',
        'username' => "{$u}_app", 'password' => "ngan'"]);
    expect($weak->status())->toBe(422)->and($weak->json('errors'))->toHaveKey('password');

    $mk(['name' => "{$u}_one"])->assertStatus(202);
    $dup = $mk(['name' => "{$u}_one"]);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/databases', 409, $dup);
    $a->account->forceFill(['limits_override' => ['database_limit' => 1]])->save();
    $q = $mk(['name' => "{$u}_two"]);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/databases', 422, $q);
    expect($q->json('code'))->toBe('quota_exceeded');
    // Account ngoài phạm vi trong body → 422 (không lộ sự tồn tại).
    $other = d6($a->spa('AD_OUT'), 'POST', '/api/v1/admin/databases', ['hosting_account_uuid' => $a->account->uuid, 'engine' => 'mysql', 'name' => "{$u}_x"]);
    expect($other->status())->toBe(422)->and($other->json('errors'))->toHaveKey('hosting_account_uuid');
});

it('SFTP/FTPS + khóa SSH: tạo, đổi mật khẩu (secret một lần), trùng/không hợp lệ, xóa; khớp hợp đồng', function () {
    $agent = d6agent();
    $a = new Actors($this);
    $u = $a->account->username;
    $in = $a->spa('AD_IN');

    $s = d6($in, 'POST', '/api/v1/admin/sftp-accounts', ['hosting_account_uuid' => $a->account->uuid, 'username' => $u,
        'protocol' => 'sftp', 'root_path' => '.']);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/sftp-accounts', 202, $s);
    expect($agent->ops())->toBe(['sshd.match.apply', 'sftp.user.ensure'])->and($s->json('secret'))->toBeString()
        ->and($agent->calls[1]['params'])->toMatchArray(['ssh_access' => false, 'password' => $s->json('secret')])
        ->and(d6secretLeaked((string) $s->json('secret')))->toBeNull();
    expect(d6($in, 'POST', '/api/v1/admin/sftp-accounts', ['hosting_account_uuid' => $a->account->uuid, 'username' => $u,
        'protocol' => 'sftp', 'root_path' => '.'])->status())->toBe(409);
    expect(d6($in, 'POST', '/api/v1/admin/sftp-accounts', ['hosting_account_uuid' => $a->account->uuid, 'username' => 'khac',
        'protocol' => 'sftp', 'root_path' => '.'])->status())->toBe(422);

    $f = d6($in, 'POST', '/api/v1/admin/sftp-accounts', ['hosting_account_uuid' => $a->account->uuid, 'username' => "{$u}_dev",
        'protocol' => 'ftps', 'root_path' => 'sites', 'password' => 'Mat-khau-ftp-2026-dai']);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/sftp-accounts', 202, $f);
    expect(collect($agent->calls)->last())->op->toBe('ftp.user.ensure')->and($f->json('secret'))->toBeNull();
    foreach ([['root_path' => '../etc'], ['root_path' => '/etc'], ['read_only' => true], ['username' => 'root']] as $bad) {
        expect(d6($in, 'POST', '/api/v1/admin/sftp-accounts', $bad + ['hosting_account_uuid' => $a->account->uuid,
            'username' => "{$u}_x", 'protocol' => 'ftps', 'root_path' => '.'])->status())->toBe(422, json_encode($bad));
    }
    $ftp = SftpAccount::query()->where('username', "{$u}_dev")->firstOrFail();
    $rot = d6($in, 'POST', "/api/v1/admin/sftp-accounts/{$ftp->uuid}:rotate-password");
    assertMatchesContract(D6A, 'post', '/api/v1/admin/sftp-accounts/{id}:rotate-password', 202, $rot);
    expect($rot->json('secret'))->toBeString()->and(d6secretLeaked((string) $rot->json('secret')))->toBeNull();
    assertMatchesContract(D6A, 'get', '/api/v1/admin/sftp-accounts', 200, $in->get('/api/v1/admin/sftp-accounts'));

    $k = d6($in, 'POST', '/api/v1/admin/ssh-keys', ['hosting_account_uuid' => $a->account->uuid, 'name' => 'Laptop', 'public_key' => D6KEY]);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/ssh-keys', 202, $k);
    expect(collect($agent->calls)->last())->op->toBe('ssh.keys.apply')
        ->and(collect($agent->calls)->last()['params']['keys'])->toHaveCount(1);
    $dupk = d6($in, 'POST', '/api/v1/admin/ssh-keys', ['hosting_account_uuid' => $a->account->uuid, 'name' => 'Lại', 'public_key' => D6KEY]);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/ssh-keys', 409, $dupk);
    foreach (['ssh-dss AAAAB3NzaC1kc3M= x', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnk', 'ssh-ed25519 !!!', "ssh-ed25519 AAAA\nssh-rsa AAAA"] as $bad) {
        expect(d6($in, 'POST', '/api/v1/admin/ssh-keys', ['hosting_account_uuid' => $a->account->uuid, 'name' => 'x', 'public_key' => $bad])
            ->status())->toBe(422, $bad);
    }
    $owner = $a->spa('US_OWNER');
    $keys = $owner->get('/api/v1/portal/ssh-keys');
    assertMatchesContract(D6P, 'get', '/api/v1/portal/ssh-keys', 200, $keys);
    expect($keys->json('data.0.fingerprint'))->toStartWith('SHA256:');
    assertMatchesContract(D6P, 'get', '/api/v1/portal/sftp-accounts', 200, $owner->get('/api/v1/portal/sftp-accounts'));
    $kd = d6($owner, 'DELETE', '/api/v1/portal/ssh-keys/'.SshKey::query()->value('uuid'));
    assertMatchesContract(D6P, 'delete', '/api/v1/portal/ssh-keys/{id}', 202, $kd);
    expect(SshKey::query()->count())->toBe(0)->and(collect($agent->calls)->last()['params']['keys'])->toBe([]);

    $fd = d6($in, 'DELETE', "/api/v1/admin/sftp-accounts/{$ftp->uuid}");
    assertMatchesContract(D6A, 'delete', '/api/v1/admin/sftp-accounts/{id}', 202, $fd);
    expect(collect($agent->calls)->last())->op->toBe('ftp.user.remove')
        ->and(SftpAccount::query()->where('uuid', $ftp->uuid)->exists())->toBeFalse();
});

it('cron: tạo/sửa (If-Match)/chạy ngay/đồng bộ lịch sử/xóa; lịch dày hơn gói, lệnh nhiều dòng → 422', function () {
    $agent = d6agent(['cron.run_once' => fn () => ['exit_code' => 0, 'timed_out' => false, 'output_tail' => "xong\n",
        'started_at' => '2026-11-21T01:00:00Z', 'finished_at' => '2026-11-21T01:00:02Z']]);
    $a = new Actors($this);
    $in = $a->spa('AD_IN');

    $tooOften = d6($in, 'POST', '/api/v1/admin/cron-jobs', ['hosting_account_uuid' => $a->account->uuid, 'schedule' => '* * * * *', 'command' => 'php artisan schedule:run']);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/cron-jobs', 422, $tooOften);
    expect($tooOften->json('errors'))->toHaveKey('schedule');
    foreach (['*/5 * * *', '61 * * * *', '0 27/1 * * *', '@reboot', '*/0 * * * *'] as $bad) {
        expect(d6($in, 'POST', '/api/v1/admin/cron-jobs', ['hosting_account_uuid' => $a->account->uuid, 'schedule' => $bad, 'command' => 'true'])
            ->status())->toBe(422, $bad);
    }
    expect(d6($in, 'POST', '/api/v1/admin/cron-jobs', ['hosting_account_uuid' => $a->account->uuid, 'schedule' => '*/5 * * * *',
        'command' => "true\nrm -rf ~"])->status())->toBe(422);

    $c = d6($in, 'POST', '/api/v1/admin/cron-jobs', ['hosting_account_uuid' => $a->account->uuid, 'schedule' => '*/5 * * * *',
        'command' => 'php artisan schedule:run', 'working_dir' => 'sites']);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/cron-jobs', 202, $c);
    expect($agent->ops())->toBe(['cron.apply'])->and($agent->calls[0]['params']['entries'])->toHaveCount(1);
    $cron = CronJob::query()->firstOrFail();
    expect($cron->status)->toBe('ready');

    $list = $in->get('/api/v1/admin/cron-jobs');
    assertMatchesContract(D6A, 'get', '/api/v1/admin/cron-jobs', 200, $list);
    $stale = d6($in, 'PATCH', "/api/v1/admin/cron-jobs/{$cron->uuid}", ['enabled' => false], ['If-Match' => '"d-0-0"']);
    assertMatchesContract(D6A, 'patch', '/api/v1/admin/cron-jobs/{id}', 412, $stale);
    $etag = '"d-'.$cron->spec_version.'-'.$cron->updated_at->getTimestamp().'"';
    $up = d6($in, 'PATCH', "/api/v1/admin/cron-jobs/{$cron->uuid}", ['enabled' => false], ['If-Match' => $etag]);
    assertMatchesContract(D6A, 'patch', '/api/v1/admin/cron-jobs/{id}', 202, $up);
    expect($agent->calls[1]['params']['entries'][0]['enabled'])->toBeFalse();
    expect(d6($in, 'PATCH', "/api/v1/admin/cron-jobs/{$cron->uuid}", ['enabled' => false])->status())->toBe(409);

    $run = d6($in, 'POST', "/api/v1/admin/cron-jobs/{$cron->uuid}:run");
    assertMatchesContract(D6A, 'post', '/api/v1/admin/cron-jobs/{id}:run', 202, $run);
    expect(collect($agent->calls)->last()['params'])->toMatchArray(['uuid' => $cron->uuid, 'timeout_sec' => 900, 'working_dir' => 'sites']);
    $runs = $in->get("/api/v1/admin/cron-jobs/{$cron->uuid}/runs");
    assertMatchesContract(D6A, 'get', '/api/v1/admin/cron-jobs/{id}/runs', 200, $runs);
    expect($runs->json('data.0'))->toMatchArray(['status' => 'succeeded', 'exit_code' => 0, 'output_tail' => "xong\n"])
        ->and($cron->refresh()->last_status)->toBe('succeeded');

    // Đồng bộ lịch: cron.inspect báo một lần chạy theo lịch (lỗi) → ghi 1 lần; chạy lại không ghi trùng.
    $agent->on('cron.inspect', fn () => ['jobs' => [['uuid' => $cron->uuid, 'last_started_at' => '2026-11-21T02:00:00Z',
        'last_finished_at' => '2026-11-21T02:00:01Z', 'result' => 'exit-code', 'exit_code' => 2]]]);
    $this->artisan('itso:cron-sync')->assertSuccessful();
    $this->artisan('itso:cron-sync')->assertSuccessful();
    expect(CronRun::query()->where('trigger', 'schedule')->count())->toBe(1)
        ->and(CronRun::query()->where('trigger', 'schedule')->first())->status->toBe('failed')->exit_code->toBe(2);

    $owner = $a->spa('US_OWNER');
    assertMatchesContract(D6P, 'get', '/api/v1/portal/cron-jobs', 200, $owner->get('/api/v1/portal/cron-jobs'));
    assertMatchesContract(D6P, 'get', '/api/v1/portal/cron-jobs/{id}/runs', 200, $owner->get("/api/v1/portal/cron-jobs/{$cron->uuid}/runs"));
    expect($a->spa('US_OTHER')->get("/api/v1/portal/cron-jobs/{$cron->uuid}/runs")->status())->toBe(404);

    $a->account->forceFill(['limits_override' => ['cron_limit' => 1]])->save();
    $q = d6($owner, 'POST', '/api/v1/portal/cron-jobs', ['hosting_account_uuid' => $a->account->uuid, 'schedule' => '0 3 * * *', 'command' => 'true']);
    assertMatchesContract(D6P, 'post', '/api/v1/portal/cron-jobs', 422, $q);
    expect($q->json('code'))->toBe('quota_exceeded');

    $del = d6($owner, 'DELETE', "/api/v1/portal/cron-jobs/{$cron->uuid}");
    assertMatchesContract(D6P, 'delete', '/api/v1/portal/cron-jobs/{id}', 202, $del);
    expect(collect($agent->calls)->last()['params']['entries'])->toBe([])
        ->and(CronJob::query()->count())->toBe(0);
});

it('File Manager: liệt kê, đọc/sửa (ETag), > 2 MiB → 422, thao tác qua job, link tải ký HMAC; ngoài phạm vi → 404', function () {
    $agent = d6agent();
    $a = new Actors($this);
    $base = "/api/v1/admin/hosting-accounts/{$a->account->uuid}/files";
    $in = $a->spa('AD_IN');

    $ls = $in->get("$base?path=.&sort=-size");
    assertMatchesContract(D6A, 'get', '/api/v1/admin/hosting-accounts/{id}/files', 200, $ls);
    expect(collect($ls->json('data'))->pluck('name')->all())->toBe(['sites', 'big.log', 'notes.txt'])
        ->and($ls->json('data.1'))->toMatchArray(['path' => 'big.log', 'mode' => '0640', 'owner' => $a->account->username]);
    $p1 = $in->get("$base?path=.&limit=2");
    expect($p1->json('data'))->toHaveCount(2)->and($in->get("$base?path=.&limit=2&cursor=".$p1->json('meta.next_cursor'))->json('data'))->toHaveCount(1);
    expect($in->get("$base?path=../etc")->status())->toBe(422)
        ->and($in->get("$base?path=/etc")->status())->toBe(422)
        ->and($a->spa('AD_OUT')->get("$base?path=.")->status())->toBe(404)
        ->and($a->spa('US_OTHER')->get("/api/v1/portal/hosting-accounts/{$a->account->uuid}/files?path=.")->status())->toBe(404);

    $rd = $in->get("$base/content?path=notes.txt");
    assertMatchesContract(D6A, 'get', '/api/v1/admin/hosting-accounts/{id}/files/content', 200, $rd);
    expect($rd->json('data'))->toMatchArray(['content' => 'xin chao its', 'encoding' => 'utf-8'])
        ->and($rd->headers->get('ETag'))->toBe('"'.hash('sha256', 'xin chao its').'"');

    $agent->on('fs.stat', fn () => ['exists' => true, 'type' => 'file', 'size' => 3 * 1024 * 1024, 'mode' => '0644', 'modified_at' => '2026-11-20T08:00:00Z']);
    $big = $in->get("$base/content?path=big.log");
    assertMatchesContract(D6A, 'get', '/api/v1/admin/hosting-accounts/{id}/files/content', 422, $big);
    $agent->on('fs.stat', fn () => ['exists' => true, 'type' => 'file', 'size' => 12, 'mode' => '0644', 'modified_at' => '2026-11-20T08:00:00Z']);

    $w = $in->call('PUT', "$base/content", ['path' => 'notes.txt', 'content' => 'noi dung moi', 'if_etag' => $rd->headers->get('ETag')]);
    assertMatchesContract(D6A, 'put', '/api/v1/admin/hosting-accounts/{id}/files/content', 200, $w);
    $wr = collect($agent->calls)->firstWhere('op', 'fs.write');
    expect($wr['params'])->toMatchArray(['path' => 'notes.txt', 'content_b64' => base64_encode('noi dung moi'), 'if_sha256' => hash('sha256', 'xin chao its')]);
    $agent->on('fs.write', fn () => ['__error' => ['precondition_failed', 'sha256 khác', false]]);
    $conf = $in->call('PUT', "$base/content", ['path' => 'notes.txt', 'content' => 'x', 'if_etag' => '"'.str_repeat('a', 64).'"']);
    assertMatchesContract(D6A, 'put', '/api/v1/admin/hosting-accounts/{id}/files/content', 412, $conf);

    $op = d6($in, 'POST', "$base:operate", ['op' => 'compress', 'paths' => ['sites', 'notes.txt'], 'target' => 'backup.zip', 'format' => 'zip']);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/hosting-accounts/{id}/files:operate', 202, $op);
    expect(collect($agent->calls)->last())->op->toBe('fs.archive')
        ->and(FileOperation::query()->where('op', 'compress')->first())->status->toBe('succeeded')->job_id->not->toBeNull();
    foreach ([['op' => 'delete', 'paths' => ['.']], ['op' => 'rename', 'paths' => ['a', 'b'], 'target' => 'c'], ['op' => 'move', 'paths' => ['a']],
        ['op' => 'chmod', 'paths' => ['a'], 'mode' => '4755'], ['op' => 'exec', 'paths' => ['a']]] as $bad) {
        expect(d6($in, 'POST', "$base:operate", $bad)->status())->toBe(422, json_encode($bad));
    }

    $dl = $in->get("$base/download?path=notes.txt");
    assertMatchesContract(D6A, 'get', '/api/v1/admin/hosting-accounts/{id}/files/download', 200, $dl);
    $url = (string) $dl->json('data.url');
    $raw = $in->get(substr($url, strpos($url, '/api/')));
    $raw->assertOk();
    expect($raw->streamedContent())->toBe('xin chao its')
        ->and($raw->headers->get('Content-Disposition'))->toContain('notes.txt');
    expect($in->get(str_replace('signature=', 'signature=0', substr($url, strpos($url, '/api/'))))->status())->toBe(403)
        ->and($a->spa('SA')->get(substr($url, strpos($url, '/api/')))->status())->toBe(403);

    $owner = $a->spa('US_OWNER');
    $pbase = "/api/v1/portal/hosting-accounts/{$a->account->uuid}/files";
    assertMatchesContract(D6P, 'get', '/api/v1/portal/hosting-accounts/{id}/files', 200, $owner->get("$pbase?path=."));
    assertMatchesContract(D6P, 'get', '/api/v1/portal/hosting-accounts/{id}/files/content', 200, $owner->get("$pbase/content?path=notes.txt"));
});

it('upload kiểu tus: tạo phiên, chunk sai offset → 409, đủ byte → job file.upload; hủy phiên; phiên người khác → 404', function () {
    $agent = d6agent();
    $a = new Actors($this);
    $base = "/api/v1/admin/hosting-accounts/{$a->account->uuid}/files/uploads";
    $in = $a->spa('AD_IN');

    $c = $in->post($base, ['path' => 'sites/a.bin', 'size' => 10]);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/hosting-accounts/{id}/files/uploads', 201, $c);
    $id = $c->json('data.uuid');
    expect($c->json('data'))->toMatchArray(['received' => 0, 'status' => 'receiving', 'chunk_size' => 8 * 1024 * 1024]);
    $u = UploadSession::query()->where('uuid', $id)->firstOrFail();
    expect(is_file(config('itso.files.upload_dir')."/$id.part"))->toBeTrue()
        ->and(decoct(fileperms(config('itso.files.upload_dir')."/$id.part") & 0777))->toBe('600');

    $send = fn (string $body, string $range) => $in->call('PATCH', "$base/$id", [], ['Content-Range' => $range], $body);
    $wrong = $send('34567', 'bytes 3-7/10');
    assertMatchesContract(D6A, 'patch', '/api/v1/admin/hosting-accounts/{id}/files/uploads/{upload}', 409, $wrong);
    expect($wrong->json('errors.received'))->toBe(['0']);
    expect($send('01234', 'bytes 0-5/10')->status())->toBe(422);
    $p1 = $send('01234', 'bytes 0-4/10');
    assertMatchesContract(D6A, 'patch', '/api/v1/admin/hosting-accounts/{id}/files/uploads/{upload}', 200, $p1);
    expect($p1->json('data.received'))->toBe(5)->and($agent->ops())->toBe([]);
    $g = $in->get("$base/$id");
    assertMatchesContract(D6A, 'get', '/api/v1/admin/hosting-accounts/{id}/files/uploads/{upload}', 200, $g);
    $p2 = $send('56789', 'bytes 5-9/10');
    expect($p2->status())->toBe(200)->and($p2->json('data.status'))->toBe('completed')->and($p2->json('data.job_uuid'))->toBeString()
        ->and($agent->ops())->toBe(['fs.upload.commit'])
        ->and($agent->calls[0]['params'])->toMatchArray(['upload_uuid' => $id, 'target' => 'sites/a.bin', 'size' => 10, 'overwrite' => false])
        ->and(file_get_contents(config('itso.files.upload_dir')."/$id.part"))->toBe('0123456789');
    expect($send('x', 'bytes 9-9/10')->status())->toBe(409);

    // Phiên của người khác (SA) không thấy được; hủy phiên đang nhận → 204, xóa staging.
    $c2 = $in->post($base, ['path' => 'b.bin', 'size' => 4]);
    $id2 = $c2->json('data.uuid');
    expect($a->spa('SA')->get("$base/$id2")->status())->toBe(404);
    $cx = $in->delete("$base/$id2");
    assertMatchesContract(D6A, 'delete', '/api/v1/admin/hosting-accounts/{id}/files/uploads/{upload}', 204, $cx);
    expect(is_file(config('itso.files.upload_dir')."/$id2.part"))->toBeFalse()
        ->and(UploadSession::query()->where('uuid', $id2)->value('status'))->toBe('cancelled');
    expect($in->post($base, ['path' => '../x', 'size' => 4])->status())->toBe(422)
        ->and($in->post($base, ['path' => 'x', 'size' => 0])->status())->toBe(422);

    $owner = $a->spa('US_OWNER');
    $pc = $owner->post("/api/v1/portal/hosting-accounts/{$a->account->uuid}/files/uploads", ['path' => 'c.bin', 'size' => 1]);
    assertMatchesContract(D6P, 'post', '/api/v1/portal/hosting-accounts/{id}/files/uploads', 201, $pc);
    expect($u->refresh()->status)->toBe('completed');
});

it('tạm khóa account: khóa DB user, tắt timer cron, vô hiệu FTPS; tài nguyên → suspended; mở khóa → ready; account không active thì không tạo mới', function () {
    $agent = d6agent();
    $a = new Actors($this);
    $u = $a->account->username;
    $sa = $a->spa('SA');
    d6($sa, 'POST', '/api/v1/admin/databases', ['hosting_account_uuid' => $a->account->uuid, 'engine' => 'mysql', 'name' => "{$u}_web", 'create_user' => true])->assertStatus(202);
    d6($sa, 'POST', '/api/v1/admin/cron-jobs', ['hosting_account_uuid' => $a->account->uuid, 'schedule' => '0 * * * *', 'command' => 'true'])->assertStatus(202);
    d6($sa, 'POST', '/api/v1/admin/sftp-accounts', ['hosting_account_uuid' => $a->account->uuid, 'username' => "{$u}_ftp", 'protocol' => 'ftps', 'root_path' => '.'])->assertStatus(202);
    $agent->calls = [];

    $acct = "/api/v1/admin/hosting-accounts/{$a->account->uuid}";
    d6($sa, 'POST', "$acct:suspend", ['reason' => 'Quá hạn'])->assertStatus(202);
    $calls = collect($agent->calls);
    expect($calls->firstWhere('op', 'db.mysql.lock')['params']['locked'] ?? null)->toBeTrue()
        ->and($calls->firstWhere('op', 'cron.apply')['params']['entries'][0]['enabled'] ?? null)->toBeFalse()
        ->and($calls->firstWhere('op', 'ftp.user.ensure')['params']['enabled'] ?? null)->toBeFalse()
        // null không bị đổi thành chuỗi '[REDACTED]' (agent sẽ coi đó là mật khẩu 10 ký tự).
        ->and($calls->firstWhere('op', 'ftp.user.ensure')['params'] ?? [])->toHaveKey('password', null);
    expect(Database::query()->value('status'))->toBe('suspended')->and(DatabaseUser::query()->value('status'))->toBe('suspended')
        ->and(CronJob::query()->value('status'))->toBe('suspended')->and(SftpAccount::query()->value('status'))->toBe('suspended');

    $blocked = d6($sa, 'POST', '/api/v1/admin/databases', ['hosting_account_uuid' => $a->account->uuid, 'engine' => 'mysql', 'name' => "{$u}_new"]);
    assertMatchesContract(D6A, 'post', '/api/v1/admin/databases', 409, $blocked);
    expect($sa->call('PUT', "$acct/files/content", ['path' => 'a.txt', 'content' => 'x'])->status())->toBe(409);

    $agent->calls = [];
    d6($sa, 'POST', "$acct:unsuspend")->assertStatus(202);
    expect(collect($agent->calls)->firstWhere('op', 'db.mysql.lock')['params']['locked'] ?? null)->toBeFalse()
        ->and(Database::query()->value('status'))->toBe('ready')->and(CronJob::query()->value('status'))->toBe('ready');
    expect(Job::query()->where('type', 'hosting_account.unsuspend')->value('state'))->toBe('succeeded');
});
