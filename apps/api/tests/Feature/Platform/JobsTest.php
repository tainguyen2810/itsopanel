<?php

use App\Domain\Jobs\JobRunner;
use App\Models\AuditLog;
use App\Models\Job;
use App\Models\Notification;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

const JA = 'itso-admin-v1.yaml';
const JP = 'itso-portal-v1.yaml';

it('job thành công: op_id job_uuid:seq:attempt, tiến độ 100, log, audit; API admin + portal khớp hợp đồng', function () {
    $agent = new FakeAgent(['*' => fn () => ['ok' => true]]);
    $a = new Actors($this);
    $job = makeJob($a)->refresh();

    expect($job->state)->toBe('succeeded')->and($job->progress)->toBe(100)->and($job->attempts)->toBe(1)
        ->and(array_column($agent->calls, 'op_id'))->toBe(["{$job->uuid}:1:1", "{$job->uuid}:2:1"])
        ->and($agent->calls[0]['requested_by'])->toBe(['user_uuid' => $a->owner->uuid, 'role' => 'USER'])
        ->and(AuditLog::query()->where('action', 'job.create')->where('job_id', $job->id)->exists())->toBeTrue();

    $sa = $a->spa('SA');
    assertMatchesContract(JA, 'get', '/api/v1/admin/jobs', 200, $sa->get('/api/v1/admin/jobs', ['filter[state]' => 'succeeded']));
    $show = $sa->get("/api/v1/admin/jobs/{$job->uuid}");
    assertMatchesContract(JA, 'get', '/api/v1/admin/jobs/{id}', 200, $show);
    expect($show->json('data.resource'))->toBe(['type' => 'hosting_account', 'uuid' => $a->account->uuid])
        ->and($show->headers->get('ETag'))->not->toBeNull();
    $logs = $sa->get("/api/v1/admin/jobs/{$job->uuid}/logs");
    assertMatchesContract(JA, 'get', '/api/v1/admin/jobs/{id}/logs', 200, $logs);
    expect(collect($logs->json('data'))->pluck('message')->last())->toContain('Hoàn tất');
    $ev = $sa->get("/api/v1/admin/jobs/{$job->uuid}/events");
    expect($ev->getStatusCode())->toBe(200)->and($ev->headers->get('Content-Type'))->toStartWith('text/event-stream')
        ->and($ev->streamedContent())->toContain('event: job');
    assertMatchesContract(JA, 'post', '/api/v1/admin/jobs/{id}:cancel', 409, $sa->post("/api/v1/admin/jobs/{$job->uuid}:cancel"));
    assertMatchesContract(JA, 'get', '/api/v1/admin/jobs/{id}', 404, $sa->get('/api/v1/admin/jobs/'.Str::uuid()));

    $po = $a->spa('US_OWNER');
    assertMatchesContract(JP, 'get', '/api/v1/portal/jobs', 200, $po->get('/api/v1/portal/jobs'));
    $pshow = $po->get("/api/v1/portal/jobs/{$job->uuid}");
    assertMatchesContract(JP, 'get', '/api/v1/portal/jobs/{id}', 200, $pshow);
    expect($pshow->json('data.links.self'))->toBe("/api/v1/portal/jobs/{$job->uuid}");
    assertMatchesContract(JP, 'get', '/api/v1/portal/jobs/{id}/logs', 200, $po->get("/api/v1/portal/jobs/{$job->uuid}/logs"));
});

it('lỗi tạm thời (retryable) được thử lại tự động với op_id mới; thành công ở lần 2', function () {
    $n = 0;
    $agent = new FakeAgent(['account.suspend' => function () use (&$n) {
        return ++$n === 1 ? ['__error' => ['agent_busy', 'Agent bận', true]] : ['ok' => true];
    }, '*' => fn () => []]);
    $a = new Actors($this);
    $job = makeJob($a)->refresh();

    expect($job->state)->toBe('succeeded')->and($job->attempts)->toBe(2)
        ->and(array_column($agent->calls, 'op_id'))->toBe(["{$job->uuid}:1:1", "{$job->uuid}:1:2", "{$job->uuid}:2:2"]);
});

it('lỗi tạm thời lặp lại tới max_attempts → failed; agent không kết nối cũng là lỗi tạm thời', function () {
    new FakeAgent(['*' => fn () => ['__error' => ['agent_busy', 'Agent bận', true]]]);
    $a = new Actors($this);
    expect(makeJob($a, 600, 2)->refresh())->state->toBe('failed')->attempts->toBe(2)->error_code->toBe('agent_busy');

    config(['itso.agent.url' => null, 'itso.agent.socket' => '/nonexistent/x.sock']);
    $j = makeJob($a, 600, 1)->refresh();
    expect($j->state)->toBe('failed')->and($j->error_code)->toBe('agent_unavailable');
});

it('lỗi không thử lại → failed, báo người yêu cầu; retry qua API cần Idempotency-Key và không chạy lại bước đã xong', function () {
    $fail = true;
    $agent = new FakeAgent(['quota.report' => function () use (&$fail) {
        return $fail ? ['__error' => ['invalid_params', 'Tham số sai', false]] : ['used_mb' => 1];
    }, '*' => fn () => []]);
    $a = new Actors($this);
    $job = makeJob($a)->refresh();
    expect($job->state)->toBe('failed')->and($job->error_code)->toBe('invalid_params')
        ->and(Notification::query()->where('user_id', $a->owner->id)->where('type', 'job.failed')->count())->toBe(1);

    $sa = $a->spa('SA');
    $f = $sa->get("/api/v1/admin/jobs/{$job->uuid}");
    expect($f->json('data.error'))->toBe(['code' => 'invalid_params', 'message' => 'Tham số sai', 'step' => 2]);

    $uri = "/api/v1/admin/jobs/{$job->uuid}:retry";
    assertMatchesContract(JA, 'post', '/api/v1/admin/jobs/{id}:retry', 422, $sa->post($uri));
    $fail = false;
    $key = (string) Str::uuid();
    $r = $sa->call('POST', $uri, [], ['Idempotency-Key' => $key]);
    assertMatchesContract(JA, 'post', '/api/v1/admin/jobs/{id}:retry', 202, $r);
    expect($job->refresh()->state)->toBe('succeeded')
        ->and($agent->ops())->toBe(['account.suspend', 'quota.report', 'quota.report']);

    $replay = $sa->call('POST', $uri, [], ['Idempotency-Key' => $key]);
    expect($replay->status())->toBe(202)->and($replay->headers->get('Idempotent-Replayed'))->toBe('true')
        ->and($replay->json())->toBe($r->json())->and(count($agent->calls))->toBe(3);
    $other = makeJob($a);
    $reuse = $sa->call('POST', "/api/v1/admin/jobs/{$other->uuid}:retry", [], ['Idempotency-Key' => $key]);
    expect($reuse->status())->toBe(409)->and($reuse->json('code'))->toBe('idempotency_key_reused');
    assertMatchesContract(JA, 'post', '/api/v1/admin/jobs/{id}:retry', 409,
        $sa->call('POST', "/api/v1/admin/jobs/{$other->uuid}:retry", [], ['Idempotency-Key' => (string) Str::uuid()]));
});

it('hủy job đang xếp hàng → cancelled; hủy lần nữa 409; job đang chạy dừng trước bước kế', function () {
    Queue::fake();
    $a = new Actors($this);
    $job = makeJob($a);
    $po = $a->spa('US_OWNER');
    $c = $po->post("/api/v1/portal/jobs/{$job->uuid}:cancel");
    assertMatchesContract(JP, 'post', '/api/v1/portal/jobs/{id}:cancel', 200, $c);
    expect($c->json('data.state'))->toBe('cancelled')
        ->and($po->post("/api/v1/portal/jobs/{$job->uuid}:cancel")->status())->toBe(409);
});

it('job đang chạy nhận yêu cầu hủy thì dừng trước bước kế', function () {
    $a = new Actors($this);
    $agent = new FakeAgent(['account.suspend' => function () {
        app(JobRunner::class)->cancel(Job::query()->latest('id')->firstOrFail());

        return [];
    }, '*' => fn () => []]);
    $job = makeJob($a)->refresh();
    expect($job->state)->toBe('cancelled')->and($agent->ops())->toBe(['account.suspend']);
});

it('job quá timeout_sec → timed_out, không chạy bước còn lại', function () {
    $a = new Actors($this);
    $agent = new FakeAgent(['account.suspend' => function () {
        $this->travel(5)->seconds();

        return [];
    }, '*' => fn () => []]);
    $job = makeJob($a, 3)->refresh();
    expect($job->state)->toBe('timed_out')->and($job->error_code)->toBe('deadline_exceeded')
        ->and($agent->ops())->toBe(['account.suspend']);
});

it('phạm vi job: ADMIN ngoài phạm vi và USER khác nhận 404', function () {
    Queue::fake();
    $a = new Actors($this);
    $job = makeJob($a);
    expect($a->spa('AD_IN')->get("/api/v1/admin/jobs/{$job->uuid}")->status())->toBe(200)
        ->and($a->spa('AD_OUT')->get("/api/v1/admin/jobs/{$job->uuid}")->status())->toBe(404)
        ->and($a->spa('US_OTHER')->get("/api/v1/portal/jobs/{$job->uuid}")->status())->toBe(404)
        ->and(collect($a->spa('AD_OUT')->get('/api/v1/admin/jobs')->json('data'))->pluck('uuid'))->not->toContain($job->uuid);
});
