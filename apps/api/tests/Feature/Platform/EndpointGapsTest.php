<?php

use App\Models\HostingPackage;
use App\Models\Job;
use Illuminate\Support\Str;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

// Các endpoint Phase 3 chưa có test riêng ở file khác (đối chiếu route:list với tests, xem docs/reports/phase-3.md).
const GA = 'itso-admin-v1.yaml';
const GP = 'itso-portal-v1.yaml';

it('chuyển server trả 501 có mã riêng (không giả thành công); purge (Phase 8) chặn account chưa chấm dứt; account người khác vẫn 404 trước', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $id = $a->account->uuid;
    $r = $sa->post("/api/v1/admin/hosting-accounts/$id:migrate", []);
    assertMatchesContract(GA, 'post', '/api/v1/admin/hosting-accounts/{id}:migrate', 501, $r);
    expect($r->json('code'))->toBe('migration_not_available');
    $idem = ['Idempotency-Key' => (string) Str::uuid()];
    assertMatchesContract(GA, 'post', '/api/v1/admin/hosting-accounts/{id}:schedule-purge', 409,
        $sa->call('POST', "/api/v1/admin/hosting-accounts/$id:schedule-purge", [], $idem));
    expect($sa->post('/api/v1/admin/hosting-accounts/'.Str::uuid().':migrate', [])->getStatusCode())->toBe(404);
    // Purge cần backups.manage (SUPER_ADMIN) → ADMIN 403.
    expect($a->spa('AD_IN')->post("/api/v1/admin/hosting-accounts/$id:schedule-purge", [])->getStatusCode())->toBe(403);
});

it('gợi ý đặt account: chấm điểm server trong phạm vi; thiếu/sai gói 422', function () {
    $a = new Actors($this);
    $pkg = HostingPackage::query()->findOrFail($a->account->packageVersion()->firstOrFail()->package_id);
    $sa = $a->spa('SA');
    $r = $sa->get('/api/v1/admin/placement/suggestions?package='.$pkg->uuid);
    assertMatchesContract(GA, 'get', '/api/v1/admin/placement/suggestions', 200, $r);
    expect(collect($r->json('data'))->pluck('server.uuid')->all())->toContain($a->server->uuid);
    assertMatchesContract(GA, 'get', '/api/v1/admin/placement/suggestions', 422, $sa->get('/api/v1/admin/placement/suggestions'));
    expect($sa->get('/api/v1/admin/placement/suggestions?package='.Str::uuid())->getStatusCode())->toBe(422);
    // ADMIN ngoài phạm vi không thấy server của account.
    $out = $a->spa('AD_OUT')->get('/api/v1/admin/placement/suggestions?package='.$pkg->uuid);
    expect(collect($out->json('data'))->pluck('server.uuid')->all())->not->toContain($a->server->uuid);
});

it('Portal: luồng sự kiện job và chạy lại job lỗi của chính mình; job người khác 404', function () {
    $fail = true;
    new FakeAgent(['*' => function () use (&$fail) {
        return $fail ? ['__error' => ['invalid_params', 'Tham số sai', false]] : ['ok' => true];
    }]);
    $a = new Actors($this);
    $job = makeJob($a)->refresh();
    expect($job->state)->toBe('failed');

    $po = $a->spa('US_OWNER');
    $ev = $po->get("/api/v1/portal/jobs/{$job->uuid}/events");
    expect($ev->getStatusCode())->toBe(200)->and($ev->headers->get('Content-Type'))->toStartWith('text/event-stream')
        ->and($ev->getContent())->toContain('event: job');
    $other = $a->spa('US_OTHER');
    expect($other->get("/api/v1/portal/jobs/{$job->uuid}/events")->getStatusCode())->toBe(404);
    expect($other->call('POST', "/api/v1/portal/jobs/{$job->uuid}:retry", [], ['Idempotency-Key' => (string) Str::uuid()])
        ->getStatusCode())->toBe(404);

    $uri = "/api/v1/portal/jobs/{$job->uuid}:retry";
    assertMatchesContract(GP, 'post', '/api/v1/portal/jobs/{id}:retry', 422, $po->post($uri));
    $fail = false;
    $r = $po->call('POST', $uri, [], ['Idempotency-Key' => (string) Str::uuid()]);
    assertMatchesContract(GP, 'post', '/api/v1/portal/jobs/{id}:retry', 202, $r);
    expect(Job::query()->findOrFail($job->id)->state)->toBe('succeeded');
    // Job đã xong không chạy lại được.
    assertMatchesContract(GP, 'post', '/api/v1/portal/jobs/{id}:retry', 409,
        $po->call('POST', $uri, [], ['Idempotency-Key' => (string) Str::uuid()]));
});
