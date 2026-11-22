<?php

use App\Domain\Jobs\JobEvents;
use App\Domain\Monitoring\DefaultAlertRules;
use App\Http\Presenters\JobPresenter;
use App\Models\Alert;
use App\Models\AlertRule;
use App\Models\Job;
use App\Models\JobLog;
use App\Models\Server;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Str;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

// Prompt 11.6 (D-106, ADR 0051): SSE sự kiện job thật, dashboard cảnh báo + sự kiện bảo mật thật.

const P116A = 'itso-admin-v1.yaml';

/** @return list<array{id: int|null, event: string, data: array<string, mixed>}> */
function p116parse(string $body): array
{
    $out = [];
    foreach (preg_split('/\n\n/', trim($body)) as $chunk) {
        $id = null;
        $event = null;
        $data = null;
        foreach (explode("\n", $chunk) as $line) {
            if (str_starts_with($line, 'id: ')) {
                $id = (int) substr($line, 4);
            } elseif (str_starts_with($line, 'event: ')) {
                $event = substr($line, 7);
            } elseif (str_starts_with($line, 'data: ')) {
                $data = json_decode(substr($line, 6), true);
            }
        }
        if ($event !== null) {
            $out[] = ['id' => $id, 'event' => $event, 'data' => $data];
        }
    }

    return $out;
}

it('SSE: snapshot đầu, log theo thứ tự id tăng, snapshot cuối khi job kết thúc; đóng luồng khi job xong', function () {
    new FakeAgent(['*' => fn () => ['ok' => true]]);
    $a = new Actors($this);
    $job = makeJob($a)->refresh();
    $res = $a->spa('SA')->get("/api/v1/admin/jobs/{$job->uuid}/events");
    expect($res->getStatusCode())->toBe(200)->and($res->headers->get('Content-Type'))->toStartWith('text/event-stream')
        ->and($res->headers->get('X-Accel-Buffering'))->toBe('no');
    $body = $res->streamedContent();
    expect($body)->toStartWith("retry: 2000\n\n");
    $ev = p116parse($body);
    expect($ev[0]['event'])->toBe('job')->and($ev[0]['data']['uuid'])->toBe($job->uuid);
    $logs = array_values(array_filter($ev, fn ($e) => $e['event'] === 'log'));
    $ids = array_column($logs, 'id');
    $dbIds = JobLog::query()->where('job_id', $job->id)->orderBy('id')->pluck('id')->all();
    expect($ids)->toBe($dbIds)->and(count($ids))->toBeGreaterThanOrEqual(4)
        ->and(array_column(array_column($logs, 'data'), 'seq'))->toBe($dbIds)
        ->and(end($logs)['data']['message'])->toContain('Hoàn tất');
    // Snapshot ban đầu đã là trạng thái cuối → không gửi lặp.
    expect(collect($ev)->where('event', 'job')->count())->toBe(1)->and($ev[0]['data']['state'])->toBe('succeeded');
});

it('SSE: Last-Event-ID bỏ sự kiện cũ; ngoài phạm vi → 404; Portal chủ account xem được', function () {
    new FakeAgent(['*' => fn () => ['ok' => true]]);
    $a = new Actors($this);
    $job = makeJob($a)->refresh();
    $dbIds = JobLog::query()->where('job_id', $job->id)->orderBy('id')->pluck('id')->all();
    $sa = $a->spa('SA');
    $res = $sa->call('GET', "/api/v1/admin/jobs/{$job->uuid}/events", [], ['Last-Event-ID' => (string) $dbIds[1]]);
    $ev = p116parse($res->streamedContent());
    expect($ev[0])->toMatchArray(['event' => 'job', 'id' => $dbIds[1]])
        ->and(array_column(array_filter($ev, fn ($e) => $e['event'] === 'log'), 'id'))->toBe(array_slice($dbIds, 2));
    // Last-Event-ID không hợp lệ → coi như 0 (gửi đủ).
    $bad = p116parse($sa->call('GET', "/api/v1/admin/jobs/{$job->uuid}/events", [], ['Last-Event-ID' => 'x; DROP'])->streamedContent());
    expect(count(array_filter($bad, fn ($e) => $e['event'] === 'log')))->toBe(count($dbIds));

    expect($a->spa('AD_OUT')->get("/api/v1/admin/jobs/{$job->uuid}/events")->getStatusCode())->toBe(404)
        ->and($a->spa('US_OTHER')->get("/api/v1/portal/jobs/{$job->uuid}/events")->getStatusCode())->toBe(404)
        ->and($sa->get('/api/v1/admin/jobs/'.Str::uuid().'/events')->status())->toBe(404);
    $po = $a->spa('US_OWNER')->get("/api/v1/portal/jobs/{$job->uuid}/events");
    expect($po->getStatusCode())->toBe(200)->and(p116parse($po->streamedContent())[0]['data']['uuid'])->toBe($job->uuid);
});

it('SSE job đang chạy: heartbeat, đóng sau thời gian tối đa; trạng thái đổi không kèm log vẫn có snapshot', function () {
    $a = new Actors($this);
    Queue::fake();
    $job = makeJob($a)->refresh();
    Job::query()->whereKey($job->id)->update(['state' => 'running']);
    config(['itso.sse.max_sec' => 0.35, 'itso.sse.heartbeat_sec' => 0.1, 'itso.sse.poll_ms' => 60]);
    $t = microtime(true);
    $body = $a->spa('SA')->get("/api/v1/admin/jobs/{$job->uuid}/events")->streamedContent();
    expect(microtime(true) - $t)->toBeLessThan(3.0)->and($body)->toContain(": ping\n\n");
    // frames(): log mới + snapshot khi trạng thái/tiến độ đổi.
    $events = app(JobEvents::class);
    $present = app(JobPresenter::class);
    $job->refresh();
    $last = (int) JobLog::query()->where('job_id', $job->id)->max('id');
    $snap = $job->state.'|'.$job->progress.'|'.$job->attempts.'|'.($job->error_code ?? '');
    [$out, $after, $snap2, $done] = $events->frames($job, 'admin', $last, $snap, $present);
    expect($out)->toBe('')->and($after)->toBe($last)->and($done)->toBeFalse();
    Job::query()->whereKey($job->id)->update(['state' => 'cancel_requested']);
    [$out] = $events->frames($job, 'admin', $last, $snap2, $present);
    expect(p116parse($out))->toHaveCount(1)->and(p116parse($out)[0]['data']['state'])->toBe('cancel_requested');
    $l = JobLog::query()->create(['job_id' => $job->id, 'level' => 'info', 'message' => 'Bước 1: x', 'at' => now()]);
    Job::query()->whereKey($job->id)->update(['state' => 'cancelled', 'progress' => 50]);
    [$out, $after, , $done] = $events->frames($job, 'admin', $last, $snap2, $present);
    expect(array_column(p116parse($out), 'event'))->toBe(['log', 'job'])->and($after)->toBe($l->id)->and($done)->toBeTrue();
});

it('JobRunner phát mỗi dòng log lên Redis pub/sub itso:job:<uuid>; Redis lỗi không làm hỏng job', function () {
    $a = new Actors($this);
    $sent = [];
    Redis::shouldReceive('connection->publish')->andReturnUsing(function (string $ch, string $msg) use (&$sent) {
        $sent[] = [$ch, json_decode($msg, true)];

        return 1;
    });
    new FakeAgent(['*' => fn () => ['ok' => true]]);
    $job = makeJob($a)->refresh();
    expect($sent)->not->toBeEmpty()->and(array_unique(array_column($sent, 0)))->toBe(["itso:job:{$job->uuid}"])
        ->and(array_column(array_column($sent, 1), 'id'))->toBe(JobLog::query()->where('job_id', $job->id)->orderBy('id')->pluck('id')->all());
    Redis::shouldReceive('connection->publish')->andThrow(new RuntimeException('redis down'));
    $job2 = makeJob($a)->refresh();
    expect($job2->state)->toBe('succeeded');
});

it('dashboard: cảnh báo firing và sự kiện bảo mật 24 giờ thật, theo phạm vi', function () {
    $a = new Actors($this);
    app(DefaultAlertRules::class)->ensure();
    $rule = AlertRule::query()->where('default_key', 'disk')->firstOrFail();
    $other = Server::factory()->create();
    foreach ([[$a->server->id, 'firing'], [$other->id, 'firing'], [$a->server->id, 'resolved']] as $i => [$sid, $st]) {
        Alert::query()->create(['rule_id' => $rule->id, 'server_id' => $sid, 'fingerprint' => "t$i", 'state' => $st, 'severity' => 'high',
            'value' => 95, 'started_at' => now(), 'below_count' => 0, 'resolved_at' => $st === 'resolved' ? now() : null]);
    }
    foreach ([[$a->server->id, now()->subHours(2)], [$a->server->id, now()->subHours(30)], [$other->id, now()->subHour()]] as [$sid, $at]) {
        DB::table('security_events')->insert(['server_id' => $sid, 'type' => 'ssh_bruteforce', 'severity' => 'high', 'message' => 'x', 'at' => $at]);
    }
    $sa = $a->spa('SA')->get('/api/v1/admin/dashboard/summary');
    assertMatchesContract(P116A, 'get', '/api/v1/admin/dashboard/summary', 200, $sa);
    expect($sa->json('data'))->toMatchArray(['alerts_firing' => 2, 'security_events_24h' => 2]);
    $in = $a->spa('AD_IN')->get('/api/v1/admin/dashboard/summary');
    expect($in->json('data'))->toMatchArray(['alerts_firing' => 1, 'security_events_24h' => 1]);
    $out = $a->spa('AD_OUT')->get('/api/v1/admin/dashboard/summary');
    expect($out->json('data'))->toMatchArray(['alerts_firing' => 0, 'security_events_24h' => 0]);
});
