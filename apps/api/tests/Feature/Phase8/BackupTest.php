<?php

use App\Models\BackupDestination;
use App\Models\BackupPolicy;
use App\Models\BackupRepository;
use App\Models\BackupSnapshot;
use App\Models\BackupVerification;
use App\Models\Database;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\PurgeRecord;
use App\Models\RestoreJob;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use Tests\Support\Actors;

require_once __DIR__.'/helpers.php';

// Prompt 8.4: API Backup & Restore (đích, policy, snapshot, kiểm chứng, khôi phục, quota, purge) qua admin và portal.

function p8dest(Actors $a, string $type = 'local', array $extra = []): BackupDestination
{
    $sa = $a->spa('SA');
    $body = $extra + ['name' => 'Đích '.$type, 'type' => $type, 'config' => $type === 'local' ? ['path' => '/var/backups/itso'] : []];
    $r = $sa->post('/api/v1/admin/backup-destinations', $body);
    $r->assertCreated();

    return BackupDestination::query()->where('uuid', $r->json('data.uuid'))->firstOrFail();
}

it('đích: SA tạo/sửa/kiểm tra, credential không lộ; ADMIN không quản lý đích; bộ khôi phục lần đầu rồi cần step-up', function () {
    $errors = [];
    $agent = p8agent($errors, ['backup.destination.test' => fn () => ['ok' => true, 'error' => null, 'latency_ms' => 7, 'append_only' => false,
        'object_lock_days' => 30, 'host_key_sha256' => null, 'ssh_public_key' => null]]);
    $a = new Actors($this);
    $sa = $a->spa('SA');

    $r = $sa->post('/api/v1/admin/backup-destinations', ['name' => 'S3 Wasabi', 'type' => 's3',
        'config' => ['endpoint' => 'https://s3.example.com', 'bucket' => 'itso-backup', 'region' => 'ap-southeast-1'],
        'credentials' => ['access_key' => 'AKIAEXAMPLE1234', 'secret_key' => 'Bi-mat-S3-rat-dai-2026!']]);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-destinations', 201, $r);
    expect($r->json('data.config'))->toEqual(['endpoint' => 'https://s3.example.com', 'bucket' => 'itso-backup', 'region' => 'ap-southeast-1'])
        ->and($r->json())->not->toHaveKey('data.credentials')->and($r->json('data.prune'))->toBe('panel');
    $id = $r->json('data.uuid');
    $d = BackupDestination::query()->where('uuid', $id)->firstOrFail();
    expect($d->credentials_encrypted)->not->toContain('Bi-mat-S3');

    // Trùng vị trí lưu → 409; local sai đường dẫn → 422.
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-destinations', 409, $sa->post('/api/v1/admin/backup-destinations', ['name' => 'X', 'type' => 's3',
        'config' => ['endpoint' => 'https://s3.example.com', 'bucket' => 'itso-backup'], 'credentials' => ['access_key' => 'AKIAEXAMPLE1234', 'secret_key' => 'zzzzzzzzzz']]));
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-destinations', 422, $sa->post('/api/v1/admin/backup-destinations', ['name' => 'L', 'type' => 'local',
        'config' => ['path' => '/tmp']]));

    $t = p8($sa, 'POST', "/api/v1/admin/backup-destinations/$id:test");
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-destinations/{id}:test', 202, $t);
    $call = collect($agent->calls)->firstWhere('op', 'backup.destination.test');
    expect($call['params']['destination']['secret_access_key'])->toBe('Bi-mat-S3-rat-dai-2026!')
        ->and(JobStep::query()->where('op', 'backup.destination.test')->firstOrFail()->params_redacted['destination']['secret_access_key'])->toHaveKey('$secret');
    $show = $sa->get("/api/v1/admin/backup-destinations/$id");
    assertMatchesContract(P8A, 'get', '/api/v1/admin/backup-destinations/{id}', 200, $show);
    expect($show->json('data.last_check_ok'))->toBeTrue()->and($show->json('data.detected.object_lock_days'))->toBe(30)
        ->and($show->json('data.prune'))->toBe('cli'); // Object Lock phát hiện được → chỉ prune bằng CLI

    $p = $sa->call('PATCH', "/api/v1/admin/backup-destinations/$id", ['name' => 'S3 chính', 'credentials' => ['secret_key' => 'Bi-mat-moi-S3-2026!!']],
        ['If-Match' => $show->headers->get('ETag')]);
    assertMatchesContract(P8A, 'patch', '/api/v1/admin/backup-destinations/{id}', 200, $p);
    assertMatchesContract(P8A, 'get', '/api/v1/admin/backup-destinations', 200, $sa->get('/api/v1/admin/backup-destinations'));

    // ADMIN (kể cả trong phạm vi) không quản lý đích.
    $in = $a->spa('AD_IN');
    assertMatchesContract(P8A, 'get', '/api/v1/admin/backup-destinations', 403, $in->get('/api/v1/admin/backup-destinations'));
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-destinations/{id}:recovery-kit', 403, $in->post("/api/v1/admin/backup-destinations/$id:recovery-kit"));

    // Bộ khôi phục: lần đầu trả đủ, xác nhận, xem lại khi phiên step-up đã hết hạn → 403.
    $kit = $sa->post("/api/v1/admin/backup-destinations/$id:recovery-kit");
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-destinations/{id}:recovery-kit', 200, $kit);
    expect($kit->json('data.first_view'))->toBeTrue()->and($kit->json('data.panel_public_key'))->toStartWith('age1')
        ->and($kit->json('data.panel_private_key'))->toStartWith('AGE-SECRET-KEY-1')->and($kit->headers->get('Cache-Control'))->toContain('no-store');
    $priv = (string) $kit->json('data.panel_private_key');
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-destinations/{id}:recovery-kit-ack', 204, $sa->post("/api/v1/admin/backup-destinations/$id:recovery-kit-ack"));
    $this->travel(11)->minutes();
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-destinations/{id}:recovery-kit', 403, $sa->post("/api/v1/admin/backup-destinations/$id:recovery-kit"));

    foreach (['Bi-mat-S3-rat-dai-2026!', 'Bi-mat-moi-S3-2026!!', $priv] as $s) {
        expect(p8leak($s))->toBeNull();
    }
    expect($errors)->toBe([]);
});

it('backup ngay + snapshot: repo init → files → DB → stats, snapshot ghi nhận; Portal chỉ thấy account mình; bí mật repo không lộ', function () {
    $errors = [];
    $agent = p8agent($errors);
    $a = new Actors($this);
    $d = p8dest($a);
    $u = $a->account->username;
    Database::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id, 'engine' => 'mariadb', 'name' => "{$u}_web",
        'charset' => 'utf8mb4', 'status' => 'ready', 'size_mb' => 1]);
    $in = $a->spa('AD_IN');

    $r = p8($in, 'POST', '/api/v1/admin/backups', ['hosting_account_uuid' => $a->account->uuid, 'contents' => ['files', 'databases'], 'note' => 'trước nâng cấp']);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backups', 202, $r);
    expect($r->json('job.type'))->toBe('backup.run')->and($r->json('job.state'))->toBe('succeeded')
        ->and($agent->ops())->toBe(['backup.repo.init', 'backup.run', 'backup.run', 'backup.stats']);
    $repo = BackupRepository::query()->where('hosting_account_id', $a->account->id)->firstOrFail();
    expect($repo->initialized_at)->not->toBeNull()->and($repo->size_bytes)->toBe(5242880)->and($repo->snapshots_count)->toBe(2)
        ->and($repo->path)->toBe("itso/{$a->server->uuid}/acct-{$a->account->uuid}");
    $pw = Crypt::decryptString($repo->password_encrypted);
    expect($agent->calls[1]['params']['repo']['password'])->toBe($pw)->and(p8leak($pw))->toBeNull()
        ->and($agent->calls[1]['params']['tags'])->toContain('manual', 'account:'.$a->account->uuid);
    $snaps = BackupSnapshot::query()->orderBy('id')->get();
    expect($snaps)->toHaveCount(2)->and($snaps[0]->scope_type)->toBe('hosting_account')->and($snaps[0]->contents)->toBe(['files'])
        ->and($snaps[1]->scope_type)->toBe('database')->and($snaps[1]->databases)->toBe(["{$u}_web"]);

    // Lần sau không init lại.
    p8($in, 'POST', '/api/v1/admin/backups', ['hosting_account_uuid' => $a->account->uuid, 'contents' => ['files']])->assertStatus(202);
    expect(array_slice($agent->ops(), 4))->toBe(['backup.run', 'backup.stats']);
    // config không backup qua đây.
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backups', 422, p8($in, 'POST', '/api/v1/admin/backups',
        ['hosting_account_uuid' => $a->account->uuid, 'contents' => ['config']]));

    $list = $in->get('/api/v1/admin/backup-snapshots?filter[hosting_account]='.$a->account->uuid);
    assertMatchesContract(P8A, 'get', '/api/v1/admin/backup-snapshots', 200, $list);
    expect($list->json('data'))->toHaveCount(3);
    assertMatchesContract(P8A, 'get', '/api/v1/admin/backup-repositories', 200, $in->get('/api/v1/admin/backup-repositories'));
    expect($a->spa('AD_OUT')->get('/api/v1/admin/backup-snapshots')->json('data'))->toBe([]);

    $own = $a->spa('US_OWNER');
    $pl = $own->get('/api/v1/portal/backup-snapshots');
    assertMatchesContract(P8P, 'get', '/api/v1/portal/backup-snapshots', 200, $pl);
    expect($pl->json('data'))->toHaveCount(3);
    $other = $a->spa('US_OTHER');
    expect($other->get('/api/v1/portal/backup-snapshots')->json('data'))->toBe([]);
    $sid = $snaps[0]->uuid;
    assertMatchesContract(P8P, 'get', '/api/v1/portal/backup-snapshots/{id}/browse', 404, $other->get("/api/v1/portal/backup-snapshots/$sid/browse?path=."));
    assertMatchesContract(P8P, 'post', '/api/v1/portal/backups', 422, p8($other, 'POST', '/api/v1/portal/backups',
        ['hosting_account_uuid' => $a->account->uuid, 'contents' => ['files']]));

    // Portal: backup ngay, duyệt, tải file (link ký 5 phút, stream theo khúc).
    $pb = p8($own, 'POST', '/api/v1/portal/backups', ['hosting_account_uuid' => $a->account->uuid, 'contents' => ['files']]);
    assertMatchesContract(P8P, 'post', '/api/v1/portal/backups', 202, $pb);
    $br = $own->get("/api/v1/portal/backup-snapshots/$sid/browse?path=.");
    assertMatchesContract(P8P, 'get', '/api/v1/portal/backup-snapshots/{id}/browse', 200, $br);
    expect($br->json('data.1.name'))->toBe('notes.txt')->and($br->json('data.1.owner'))->toBe($u);
    assertMatchesContract(P8P, 'post', '/api/v1/portal/backup-snapshots/{id}:download-link', 422,
        $own->post("/api/v1/portal/backup-snapshots/$sid:download-link", ['path' => null]));
    $link = $own->post("/api/v1/portal/backup-snapshots/$sid:download-link", ['path' => 'notes.txt']);
    assertMatchesContract(P8P, 'post', '/api/v1/portal/backup-snapshots/{id}:download-link', 200, $link);
    $url = parse_url((string) $link->json('data.url'));
    $raw = $own->get($url['path'].'?'.$url['query']);
    $raw->assertOk();
    expect($raw->streamedContent())->toBe('xin chao itso')->and($raw->headers->get('Content-Disposition'))->toContain('notes.txt');
    // Link của người khác / chữ ký sai → 403/404.
    $own->get($url['path'].'?'.str_replace('signature=', 'signature=0', $url['query']))->assertStatus(403);
    $this->travel(6)->minutes();
    $own->get($url['path'].'?'.$url['query'])->assertStatus(403);

    expect($errors)->toBe([]);
});

it('policy + itso:backup-due: lịch đến hạn chạy (jitter, khóa), retention forget bản cũ; đích bất biến không forget; quota tạm dừng', function () {
    $errors = [];
    $agent = p8agent($errors);
    $a = new Actors($this);
    $d = p8dest($a);
    $sa = $a->spa('SA');

    $r = $sa->post('/api/v1/admin/backup-policies', ['name' => 'Hằng đêm', 'scope_type' => 'hosting_account', 'scope_uuid' => $a->account->uuid,
        'contents' => ['files'], 'schedule' => '0 2 * * *', 'destination_uuids' => [$d->uuid], 'retention' => ['last' => 1]]);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-policies', 201, $r);
    expect($r->json('data.scope_uuid'))->toBe($a->account->uuid)->and($r->json('data.retention_mode'))->toBe('panel')
        ->and($r->json('data.next_run_at'))->not->toBeNull();
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-policies', 422, $sa->post('/api/v1/admin/backup-policies', ['name' => 'Sai', 'scope_type' => 'server',
        'contents' => ['files'], 'schedule' => 'bad cron', 'destination_uuids' => [$d->uuid]]));
    assertMatchesContract(P8A, 'get', '/api/v1/admin/backup-policies', 200, $sa->get('/api/v1/admin/backup-policies'));
    assertMatchesContract(P8A, 'get', '/api/v1/admin/backup-policies', 403, $a->spa('AD_IN')->get('/api/v1/admin/backup-policies'));
    $p = BackupPolicy::query()->where('uuid', $r->json('data.uuid'))->firstOrFail();

    // Chưa đến hạn → không chạy.
    $this->artisan('itso:backup-due')->assertSuccessful();
    expect($agent->ops())->toBe([]);
    $this->travelTo(Carbon::parse($p->next_run_at)->addMinute());
    $this->artisan('itso:backup-due')->assertSuccessful();
    $p->refresh();
    expect($agent->ops())->toBe(['backup.repo.init', 'backup.run', 'backup.stats'])->and($p->last_status)->toBe('succeeded')
        ->and($p->next_run_at->isFuture())->toBeTrue()->and($p->next_run_at->format('H:i'))->toMatch('/^02:0[0-4]$/');
    expect($agent->calls[1]['params']['tags'])->toContain('policy:'.$p->uuid);

    // Lần hai (run thủ công) → giữ 1 bản: forget bản cũ.
    $sa = $a->spa('SA'); // phiên cũ hết hạn sau khi dời đồng hồ
    $run = p8($sa, 'POST', "/api/v1/admin/backup-policies/{$p->uuid}:run");
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-policies/{id}:run', 202, $run);
    expect(array_slice($agent->ops(), 3))->toBe(['backup.run', 'backup.stats', 'backup.forget'])
        ->and(BackupSnapshot::query()->count())->toBe(1);

    // Đích bất biến → không forget theo retention.
    $d->forceFill(['append_only' => true])->save();
    p8($sa, 'POST', "/api/v1/admin/backup-policies/{$p->uuid}:run")->assertStatus(202);
    expect(collect($agent->ops())->filter(fn ($o) => $o === 'backup.forget'))->toHaveCount(1)
        ->and(BackupSnapshot::query()->count())->toBe(2);
    $pol = $sa->get("/api/v1/admin/backup-policies/{$p->uuid}");
    assertMatchesContract(P8A, 'get', '/api/v1/admin/backup-policies/{id}', 200, $pol);
    expect($pol->json('data.retention_mode'))->toBe('cli');

    // Quota: gói 1 MB, đang dùng 5 MB (> 120 %) → tạm dừng backup ngay và policy bỏ qua account.
    $a->account->forceFill(['limits_override' => ['backup_quota_mb' => 1]])->save();
    $q = p8($a->spa('US_OWNER'), 'POST', '/api/v1/portal/backups', ['hosting_account_uuid' => $a->account->uuid, 'contents' => ['files']]);
    assertMatchesContract(P8P, 'post', '/api/v1/portal/backups', 409, $q);
    expect($q->json('code'))->toBe('quota_exceeded');
    $n = count($agent->calls);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-policies/{id}:run', 409, p8($sa, 'POST', "/api/v1/admin/backup-policies/{$p->uuid}:run"));
    expect(count($agent->calls))->toBe($n);
    $ov = $sa->get('/api/v1/admin/backups/overview');
    assertMatchesContract(P8A, 'get', '/api/v1/admin/backups/overview', 200, $ov);
    expect($ov->json('data.quota.0.state'))->toBe('paused')->and($ov->json('data.quota.0.hosting_account.uuid'))->toBe($a->account->uuid);

    assertMatchesContract(P8A, 'delete', '/api/v1/admin/backup-policies/{id}', 204, $sa->delete("/api/v1/admin/backup-policies/{$p->uuid}"));
    expect($errors)->toBe([]);
});

it('kiểm chứng + xóa snapshot: check/restore test ghi verification; xóa chỉ SA + step-up, đích bất biến bị chặn; tổng quan 3-2-1-1-0', function () {
    $errors = [];
    $agent = p8agent($errors);
    $a = new Actors($this);
    $d = p8dest($a);
    $in = $a->spa('AD_IN');
    p8($in, 'POST', '/api/v1/admin/backups', ['hosting_account_uuid' => $a->account->uuid, 'contents' => ['files']])->assertStatus(202);
    $s = BackupSnapshot::query()->firstOrFail();

    $v = p8($in, 'POST', "/api/v1/admin/backup-snapshots/{$s->uuid}:verify");
    assertMatchesContract(P8A, 'post', '/api/v1/admin/backup-snapshots/{id}:verify', 202, $v);
    expect(array_slice($agent->ops(), -2))->toBe(['backup.check', 'backup.restore_test'])->and($s->refresh()->verified_at)->not->toBeNull();
    $vl = $in->get('/api/v1/admin/backup-verifications');
    assertMatchesContract(P8A, 'get', '/api/v1/admin/backup-verifications', 200, $vl);
    expect(collect($vl->json('data'))->pluck('state')->all())->toBe(['succeeded', 'succeeded']);
    expect(p8($a->spa('AD_OUT'), 'POST', "/api/v1/admin/backup-snapshots/{$s->uuid}:verify")->status())->toBe(404);

    // Restore test sai lệch → failed + lỗi trong tổng quan.
    $agent->on('backup.restore_test', fn () => ['ok' => false, 'verified_files' => 11,
        'mismatches' => [['path' => 'sites/a.php', 'expected_sha256' => hash('sha256', 'a'), 'actual_sha256' => null]], 'databases_ok' => 0]);
    p8($in, 'POST', "/api/v1/admin/backup-snapshots/{$s->uuid}:verify")->assertStatus(202);
    $bad = BackupVerification::query()->where('kind', 'restore_test')->latest('id')->firstOrFail();
    expect($bad->state)->toBe('failed')->and($bad->mismatches)->toBe(1)->and($bad->error)->toContain('sites/a.php');
    $sa = $a->spa('SA');
    $ov = $sa->get('/api/v1/admin/backups/overview');
    assertMatchesContract(P8A, 'get', '/api/v1/admin/backups/overview', 200, $ov);
    $rules = collect($ov->json('data.rules'))->keyBy('key');
    expect($rules['copies']['ok'])->toBeFalse()->and($rules['offsite']['ok'])->toBeFalse()->and($rules['errors']['value'])->toBe(1)
        ->and($ov->json('data.last_backup_at'))->not->toBeNull();

    // Xóa: ADMIN 403; SA (step-up) → forget; đích bất biến → 409.
    assertMatchesContract(P8A, 'delete', '/api/v1/admin/backup-snapshots/{id}', 403, $in->call('DELETE', "/api/v1/admin/backup-snapshots/{$s->uuid}", [],
        ['Idempotency-Key' => 'k-del-1']));
    $d->forceFill(['immutable_days' => 30, 'type' => 's3'])->save();
    assertMatchesContract(P8A, 'delete', '/api/v1/admin/backup-snapshots/{id}', 409, p8($sa, 'DELETE', "/api/v1/admin/backup-snapshots/{$s->uuid}"));
    $d->forceFill(['immutable_days' => null, 'type' => 'local'])->save();
    $del = p8($sa, 'DELETE', "/api/v1/admin/backup-snapshots/{$s->uuid}");
    assertMatchesContract(P8A, 'delete', '/api/v1/admin/backup-snapshots/{id}', 202, $del);
    expect(collect($agent->calls)->last()['params']['snapshot_ids'])->toBe([$s->restic_snapshot_id])
        ->and(BackupSnapshot::query()->whereKey($s->id)->exists())->toBeFalse();
    expect($errors)->toBe([]);
});

it('khôi phục: new (website/file/DB mới) và overwrite (step-up + gõ username, snapshot pre-restore); Portal khôi phục của mình', function () {
    $errors = [];
    $agent = p8agent($errors);
    $a = new Actors($this);
    p8dest($a);
    $u = $a->account->username;
    Database::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id, 'engine' => 'mariadb', 'name' => "{$u}_web",
        'charset' => 'utf8mb4', 'status' => 'ready', 'size_mb' => 1]);
    $in = $a->spa('AD_IN');
    p8($in, 'POST', '/api/v1/admin/backups', ['hosting_account_uuid' => $a->account->uuid, 'contents' => ['files', 'databases']])->assertStatus(202);
    $files = BackupSnapshot::query()->where('scope_type', 'hosting_account')->firstOrFail();
    $dbSnap = BackupSnapshot::query()->where('scope_type', 'database')->firstOrFail();

    $r = p8($in, 'POST', '/api/v1/admin/restores', ['snapshot_uuid' => $files->uuid, 'mode' => 'new', 'items' => ['files:sites/demo.vn', 'files:notes.txt']]);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/restores', 202, $r);
    $call = collect($agent->calls)->last();
    expect($call['op'])->toBe('backup.restore')->and($call['params']['items'])->toBe([['kind' => 'files', 'path' => 'sites/demo.vn'], ['kind' => 'files', 'path' => 'notes.txt']]);
    $rj = RestoreJob::query()->latest('id')->firstOrFail();
    expect($rj->status)->toBe('succeeded');
    $show = $in->get("/api/v1/admin/restores/{$rj->uuid}");
    assertMatchesContract(P8A, 'get', '/api/v1/admin/restores/{id}', 200, $show);
    expect($show->json('data.result.restored_paths'))->toBe(['backups/restore-1121/sites/demo.vn']);

    // DB ở chế độ new → DB mới <tên>_r<mdHi>, sẵn sàng sau job.
    $rd = p8($in, 'POST', '/api/v1/admin/restores', ['snapshot_uuid' => $dbSnap->uuid, 'mode' => 'new', 'items' => ["database:{$u}_web"]]);
    $rd->assertStatus(202);
    $new = Database::query()->where('name', 'like', "{$u}_web_r%")->firstOrFail();
    expect($new->status)->toBe('ready');
    assertMatchesContract(P8A, 'post', '/api/v1/admin/restores', 422, p8($in, 'POST', '/api/v1/admin/restores',
        ['snapshot_uuid' => $dbSnap->uuid, 'mode' => 'new', 'items' => ['database:khong_co']]));

    // Overwrite: sai username → 422; step-up hết hạn → 403; đúng → pre-restore snapshot.
    assertMatchesContract(P8A, 'post', '/api/v1/admin/restores', 422, p8($in, 'POST', '/api/v1/admin/restores',
        ['snapshot_uuid' => $dbSnap->uuid, 'mode' => 'overwrite', 'items' => ["database:{$u}_web"], 'confirm' => 'sai']));
    $this->travel(11)->minutes();
    $no = p8($in, 'POST', '/api/v1/admin/restores', ['snapshot_uuid' => $dbSnap->uuid, 'mode' => 'overwrite', 'items' => ["database:{$u}_web"], 'confirm' => $u]);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/restores', 403, $no);
    expect($no->json('code'))->toBe('mfa_step_up_required');
    $in2 = $a->spa('AD_IN');
    $ow = p8($in2, 'POST', '/api/v1/admin/restores', ['snapshot_uuid' => $dbSnap->uuid, 'mode' => 'overwrite', 'items' => ["database:{$u}_web"], 'confirm' => $u]);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/restores', 202, $ow);
    $rj = RestoreJob::query()->latest('id')->firstOrFail();
    expect($rj->pre_restore_snapshot_id)->not->toBeNull()
        ->and(BackupSnapshot::query()->findOrFail($rj->pre_restore_snapshot_id)->tags)->toContain('pre-restore')
        ->and(collect($agent->calls)->last()['params']['items'][0])->toEqual(['kind' => 'database', 'db' => ['engine' => 'mariadb', 'name' => "{$u}_web"],
            'target_name' => "{$u}_web"]);

    // Portal: khôi phục của mình (cần step-up), danh sách; USER khác không thấy.
    $own = $a->spa('US_OWNER');
    $pr = p8($own, 'POST', '/api/v1/portal/restores', ['snapshot_uuid' => $files->uuid, 'mode' => 'new', 'items' => ['files:notes.txt']]);
    assertMatchesContract(P8P, 'post', '/api/v1/portal/restores', 403, $pr); // phiên portal chưa bật MFA/step-up
    $secret = Actors::enrollAndStepUp($this, $own);
    $pr = p8($own, 'POST', '/api/v1/portal/restores', ['snapshot_uuid' => $files->uuid, 'mode' => 'new', 'items' => ['files:notes.txt']]);
    assertMatchesContract(P8P, 'post', '/api/v1/portal/restores', 202, $pr);
    $pl = $own->get('/api/v1/portal/restores');
    assertMatchesContract(P8P, 'get', '/api/v1/portal/restores', 200, $pl);
    expect($pl->json('data'))->toHaveCount(4);
    assertMatchesContract(P8P, 'get', '/api/v1/portal/restores/{id}', 404, $a->spa('US_OTHER')->get("/api/v1/portal/restores/{$rj->uuid}"));
    assertMatchesContract(P8A, 'get', '/api/v1/admin/restores', 200, $in2->get('/api/v1/admin/restores'));
    expect($errors)->toBe([]);
});

it('purge (D-46): chỉ account đã chấm dứt; xác nhận bị chặn khi backup cuối chưa kiểm chứng; đủ điều kiện → account.remove + biên bản', function () {
    $errors = [];
    $agent = p8agent($errors, ['backup.restore_test' => fn () => ['ok' => false, 'verified_files' => 3,
        'mismatches' => [['path' => 'sites/x.php', 'expected_sha256' => hash('sha256', 'x'), 'actual_sha256' => hash('sha256', 'y')]], 'databases_ok' => 0]]);
    $a = new Actors($this);
    p8dest($a);
    $sa = $a->spa('SA');
    $id = $a->account->uuid;
    $u = $a->account->username;

    assertMatchesContract(P8A, 'post', '/api/v1/admin/hosting-accounts/{id}:schedule-purge', 409, p8($sa, 'POST', "/api/v1/admin/hosting-accounts/$id:schedule-purge", []));
    assertMatchesContract(P8A, 'post', '/api/v1/admin/hosting-accounts/{id}:schedule-purge', 403,
        p8($a->spa('AD_IN'), 'POST', "/api/v1/admin/hosting-accounts/$id:schedule-purge", []));
    $a->account->forceFill(['lifecycle_state' => 'terminated', 'terminated_at' => now(), 'purge_after' => now()->addDays(30)])->save();

    $s = p8($sa, 'POST', "/api/v1/admin/hosting-accounts/$id:schedule-purge", ['final_backup' => true, 'note' => 'hết hợp đồng']);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/hosting-accounts/{id}:schedule-purge', 202, $s);
    expect($agent->ops())->toBe(['backup.repo.init', 'backup.run', 'backup.stats', 'backup.check', 'backup.restore_test'])
        ->and($agent->calls[1]['params']['tags'])->toContain('final');
    $pr = PurgeRecord::query()->firstOrFail();
    expect($pr->final_backup_snapshot_id)->not->toBeNull()->and($pr->backup_verified_at)->toBeNull();

    // Restore test thất bại → xác nhận bị chặn.
    $c = p8($sa, 'POST', "/api/v1/admin/hosting-accounts/$id:confirm-purge", ['purge_uuid' => $pr->uuid, 'confirm_username' => $u]);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/hosting-accounts/{id}:confirm-purge', 409, $c);
    expect($c->json('detail'))->toContain('D-46')->and(collect($agent->ops())->contains('account.remove'))->toBeFalse();

    // Kiểm chứng lại đạt → vẫn chưa tới hạn giữ dữ liệu → 409; tới hạn → purge.
    $agent->on('backup.restore_test', fn () => ['ok' => true, 'verified_files' => 3, 'mismatches' => [], 'databases_ok' => 0]);
    $snap = BackupSnapshot::query()->findOrFail($pr->final_backup_snapshot_id);
    p8($sa, 'POST', "/api/v1/admin/backup-snapshots/{$snap->uuid}:verify")->assertStatus(202);
    expect($pr->refresh()->backup_verified_at)->not->toBeNull();
    assertMatchesContract(P8A, 'post', '/api/v1/admin/hosting-accounts/{id}:confirm-purge', 422,
        p8($sa, 'POST', "/api/v1/admin/hosting-accounts/$id:confirm-purge", ['purge_uuid' => $pr->uuid, 'confirm_username' => 'sai']));
    expect(p8($sa, 'POST', "/api/v1/admin/hosting-accounts/$id:confirm-purge", ['purge_uuid' => $pr->uuid, 'confirm_username' => $u])->json('title'))
        ->toBe('Chưa tới hạn purge');
    // Hết thời gian giữ (trigger DB so với now() của PostgreSQL nên dời mốc thay vì travel); người lên lịch không tự xác nhận.
    $a->account->forceFill(['purge_after' => now()->subDay()])->save();
    $pr->forceFill(['scheduled_for' => now()->subDay()])->save();
    $self = p8($sa, 'POST', "/api/v1/admin/hosting-accounts/$id:confirm-purge", ['purge_uuid' => $pr->uuid, 'confirm_username' => $u]);
    expect($self->status())->toBe(409)->and($self->json('title'))->toBe('Cần người xác nhận thứ hai');
    $sa2 = User::factory()->superAdmin()->create();
    $sa = $this->spa('admin');
    $sa->login($sa2)->assertOk();
    Actors::enrollAndStepUp($this, $sa);
    $ok = p8($sa, 'POST', "/api/v1/admin/hosting-accounts/$id:confirm-purge", ['purge_uuid' => $pr->uuid, 'confirm_username' => $u]);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/hosting-accounts/{id}:confirm-purge', 202, $ok);
    $call = collect($agent->calls)->last();
    expect($call['op'])->toBe('account.remove')->and($call['params']['final_snapshot_id'])->toBe($snap->restic_snapshot_id);
    $pr->refresh();
    expect($pr->completed_at)->not->toBeNull()->and($pr->confirmed_by_user_id)->toBe($sa2->id)
        ->and($a->account->refresh()->lifecycle_state)->toBe('purged');
    $list = $sa->get('/api/v1/admin/purge-records');
    assertMatchesContract(P8A, 'get', '/api/v1/admin/purge-records', 200, $list);
    expect($list->json('data.0.objects.0.kind'))->toBe('home');
    expect($errors)->toBe([]);
});

it('ma trận quyền backup: USER không vào /admin; ADMIN không quản lý đích/policy/xóa/purge; ngoài phạm vi 404', function () {
    $errors = [];
    p8agent($errors);
    $a = new Actors($this);
    $d = p8dest($a);
    $matrix = [
        ['GET', '/api/v1/admin/backups/overview', ['SA' => 200, 'AD_IN' => 200, 'AD_OUT' => 200]],
        ['GET', '/api/v1/admin/backup-repositories', ['SA' => 200, 'AD_IN' => 200, 'AD_OUT' => 200]],
        ['GET', '/api/v1/admin/backup-snapshots', ['SA' => 200, 'AD_IN' => 200, 'AD_OUT' => 200]],
        ['GET', '/api/v1/admin/restores', ['SA' => 200, 'AD_IN' => 200, 'AD_OUT' => 200]],
        ['GET', '/api/v1/admin/backup-destinations', ['SA' => 200, 'AD_IN' => 403, 'AD_OUT' => 403]],
        ['GET', "/api/v1/admin/backup-destinations/{$d->uuid}", ['SA' => 200, 'AD_IN' => 403, 'AD_OUT' => 403]],
        ['GET', '/api/v1/admin/backup-policies', ['SA' => 200, 'AD_IN' => 403, 'AD_OUT' => 403]],
        ['GET', '/api/v1/admin/purge-records', ['SA' => 200, 'AD_IN' => 403, 'AD_OUT' => 403]],
    ];
    foreach (['SA', 'AD_IN', 'AD_OUT'] as $who) {
        $spa = $a->spa($who);
        foreach ($matrix as [$m, $uri, $want]) {
            expect($spa->call($m, $uri)->status())->toBe($want[$who], "$who $m $uri");
        }
    }
    $out = $a->spa('AD_OUT');
    expect(p8($out, 'POST', '/api/v1/admin/backups', ['hosting_account_uuid' => $a->account->uuid, 'contents' => ['files']])->status())->toBe(422);
    $own = $a->spa('US_OWNER');
    expect($own->get('/api/v1/admin/backup-snapshots')->status())->toBeIn([401, 403]);
    expect(Job::query()->count())->toBe(0)->and($errors)->toBe([]);
});
