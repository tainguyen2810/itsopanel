<?php

use App\Domain\Monitoring\AlertEngine;
use App\Domain\Monitoring\DefaultAlertRules;
use App\Domain\Monitoring\UptimeService;
use App\Domain\Servers\MetricsCollector;
use App\Models\Agent;
use App\Models\Alert;
use App\Models\AlertRule;
use App\Models\Notification;
use App\Models\UptimeCheck;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

// Prompt 11.4 (D-102, D-105): rule mặc định, bộ máy cảnh báo, mất kết nối ≤ 2 phút, ack/silence/nhắc lại, uptime.

const P114A = 'itso-admin-v1.yaml';
const P114P = 'itso-portal-v1.yaml';

function p114agent(Actors $a, ?Carbon $seen = null): Agent
{
    return Agent::query()->create(['server_id' => $a->server->id, 'transport' => 'local', 'last_seen_at' => $seen ?? now()]);
}

function p114eval(): array
{
    return app(AlertEngine::class)->evaluate();
}

function p114disk(Actors $a, float $pct): void
{
    app(MetricsCollector::class)->insertSamples($a->server->id, null, ['disk_pct' => $pct], now());
}

/** Rule mặc định theo khóa; các rule mặc định khác tắt để test chỉ nhìn một nguồn. */
function p114only(string $key): AlertRule
{
    app(DefaultAlertRules::class)->ensure();
    AlertRule::query()->where('default_key', '<>', $key)->update(['enabled' => false]);

    return AlertRule::query()->where('default_key', $key)->firstOrFail();
}

function p114notes(string $type): int
{
    return Notification::query()->where('type', $type)->count();
}

it('agent im lặng ≥ 90 giây → firing ở lượt đánh giá kế tiếp, tổng ≤ 2 phút; thông báo SA + ADMIN trong phạm vi', function () {
    $a = new Actors($this);
    $t0 = now()->startOfMinute();
    $this->travelTo($t0);
    p114agent($a, $t0);
    p114only('agent_offline');
    $this->travelTo($t0->copy()->addSeconds(60));
    p114eval();
    expect(Alert::query()->count())->toBe(0);
    $this->travelTo($t0->copy()->addSeconds(120)); // lượt kế tiếp: 120 giây ≥ 90 → firing ngay (bỏ qua duration)
    $this->artisan('itso:alerts-evaluate')->assertSuccessful();
    $al = Alert::query()->sole();
    expect($al->state)->toBe('firing')->and($al->severity)->toBe('critical')
        ->and($al->firing_at->diffInSeconds($t0, true))->toBeLessThanOrEqual(120.0)
        ->and($al->message)->toContain($a->server->name);
    $to = Notification::query()->where('type', 'alert.firing')->pluck('user_id')->all();
    expect($to)->toContain($a->sa->id, $a->adminIn->id)->not->toContain($a->adminOut->id, $a->owner->id);
    // Agent trả lời lại → hai lượt dưới ngưỡng → resolved.
    Agent::query()->update(['last_seen_at' => now()]);
    p114eval();
    expect($al->refresh()->state)->toBe('firing')->and($al->below_count)->toBe(1);
    $this->travel(60)->seconds();
    Agent::query()->update(['last_seen_at' => now()]);
    p114eval();
    expect($al->refresh()->state)->toBe('resolved')->and(p114notes('alert.resolved'))->toBeGreaterThan(0);
});

it('disk 91 % kéo dài → pending → firing; xuống 85 % hai lượt → resolved; không nhân đôi', function () {
    $a = new Actors($this);
    p114agent($a);
    $rule = p114only('disk');
    expect($rule->duration_sec)->toBe(60);
    p114disk($a, 91.0);
    p114eval();
    $al = Alert::query()->sole();
    expect($al->state)->toBe('pending')->and(p114notes('alert.firing'))->toBe(0);
    $this->travel(60)->seconds();
    p114disk($a, 91.5);
    p114eval();
    expect($al->refresh()->state)->toBe('firing')->and($al->value)->toBe(91.5)->and(p114notes('alert.firing'))->toBeGreaterThan(0);
    $this->travel(60)->seconds();
    p114disk($a, 92.0);
    p114eval();
    expect(Alert::query()->count())->toBe(1);
    foreach ([1, 2] as $round) {
        $this->travel(60)->seconds();
        p114disk($a, 85.0);
        p114eval();
        expect($al->refresh()->state)->toBe($round === 1 ? 'firing' : 'resolved');
    }
    // Vượt lại sau khi resolved → cảnh báo mới (fingerprint được dùng lại khi cảnh báo cũ đã đóng).
    $this->travel(60)->seconds();
    p114disk($a, 95.0);
    p114eval();
    expect(Alert::query()->count())->toBe(2);
    // Số liệu cũ (agent không gửi mẫu mới) không làm đổi trạng thái.
    $this->travel(10)->minutes();
    p114eval();
    expect(Alert::query()->where('state', 'pending')->count())->toBe(1);
});

it('pending dưới ngưỡng trước khi đủ thời gian → resolved không thông báo', function () {
    $a = new Actors($this);
    p114agent($a);
    p114only('disk');
    p114disk($a, 93.0);
    p114eval();
    $this->travel(30)->seconds();
    p114disk($a, 80.0);
    p114eval();
    expect(Alert::query()->sole()->state)->toBe('resolved')->and(Notification::query()->count())->toBe(0);
});

it('ack ngừng nhắc lại; silence hết hạn thì nhắc lại; rule tắt → resolved', function () {
    $a = new Actors($this);
    p114agent($a);
    $rule = p114only('disk');
    $rule->forceFill(['duration_sec' => 0, 'repeat_sec' => 600])->save();
    p114disk($a, 95.0);
    p114eval();
    $al = Alert::query()->sole();
    expect($al->state)->toBe('firing')->and(p114notes('alert.firing'))->toBeGreaterThan(0);
    $step = function (int $sec) use ($a): void {
        $this->travel($sec)->seconds();
        p114disk($a, 95.0);
        p114eval();
    };
    $step(300);
    expect(p114notes('alert.repeat'))->toBe(0);
    $step(300);
    $perRound = p114notes('alert.repeat');
    expect($perRound)->toBeGreaterThan(0);

    // Silence 15 phút: không nhắc trong lúc silence, hết hạn thì nhắc lại ngay lượt đầu tiên.
    $sa = $a->spa('SA');
    $s = $sa->post("/api/v1/admin/alerts/{$al->uuid}:silence", ['duration_sec' => 900, 'reason' => 'bảo trì']);
    assertMatchesContract(P114A, 'post', '/api/v1/admin/alerts/{id}:silence', 200, $s);
    expect($s->json('data.silenced_until'))->not->toBeNull();
    $step(600);
    expect(p114notes('alert.repeat'))->toBe($perRound);
    $step(420);
    expect(p114notes('alert.repeat'))->toBe(2 * $perRound);

    // Ack: không nhắc nữa dù quá repeat_sec.
    $ack = $sa->post("/api/v1/admin/alerts/{$al->uuid}:ack");
    assertMatchesContract(P114A, 'post', '/api/v1/admin/alerts/{id}:ack', 200, $ack);
    expect($ack->json('data.acknowledged_by.uuid'))->toBe($a->sa->uuid)
        ->and($sa->post("/api/v1/admin/alerts/{$al->uuid}:ack")->status())->toBe(409);
    $step(1200);
    expect(p114notes('alert.repeat'))->toBe(2 * $perRound);
    expect($sa->post("/api/v1/admin/alerts/{$al->uuid}:unsilence")->status())->toBe(409);

    $rule->forceFill(['enabled' => false])->save();
    p114eval();
    expect($al->refresh()->state)->toBe('resolved');
    expect(DB::table('audit_logs')->whereIn('action', ['alert.ack', 'alert.silence'])->count())->toBe(2);
});

it('uptime: website SSL tự bật check; 3 lỗi → down → cảnh báo cho admin + USER chủ; 1 lần thành công → up', function () {
    $a = new Actors($this);
    p114agent($a);
    p114only('uptime_down');
    $w = Website::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id,
        'primary_domain' => 'anphat.vn', 'status' => 'ready', 'ssl_mode' => 'acme']);
    $c = UptimeCheck::query()->where('website_id', $w->id)->sole();
    expect($c->path)->toBe('/')->and($c->enabled)->toBeTrue();
    $ok = false;
    $agent = new FakeAgent(['uptime.probe' => function (array $env) use (&$ok): array {
        return ['results' => array_map(fn (array $t) => ['check_uuid' => $t['check_uuid'],
            'ok' => $ok, 'status' => $ok ? 200 : 503, 'duration_ms' => 120, 'cert_expires_at' => '2027-01-01T00:00:00Z',
            'keyword_found' => null, 'error' => $ok ? null : 'HTTP Service Unavailable'], $env['params']['targets'])];
    },
        '*' => fn () => ['ok' => true]]);
    foreach ([1, 2, 3] as $n) {
        $this->artisan('itso:uptime-probe')->assertSuccessful();
        expect($c->refresh()->consecutive_failures)->toBe($n)->and($c->state)->toBe($n < 3 ? 'unknown' : 'down');
        p114eval();
        $this->travel(60)->seconds();
    }
    $call = collect($agent->calls)->firstWhere('op', 'uptime.probe');
    expect($call['params']['targets'][0])->toMatchArray(['host' => 'anphat.vn', 'path' => '/', 'scheme' => 'https'])
        ->and($call['params']['timeout_sec'])->toBe(10);
    expect(Alert::query()->where('state', 'firing')->count())->toBe(1)
        ->and(Notification::query()->where('type', 'alert.firing')->pluck('user_id')->all())->toContain($a->owner->id, $a->sa->id)
        ->not->toContain($a->otherUser->id);
    // Chưa đến hạn (interval 60 giây) → không gọi lại.
    $this->travel(-30)->seconds();
    $before = count($agent->calls);
    $this->artisan('itso:uptime-probe')->assertSuccessful();
    expect(count($agent->calls))->toBe($before);
    $this->travel(30)->seconds();
    $ok = true;
    $this->artisan('itso:uptime-probe')->assertSuccessful();
    expect($c->refresh()->state)->toBe('up')->and($c->consecutive_failures)->toBe(0)->and($c->down_since)->toBeNull()
        ->and($c->cert_expires_at?->toDateString())->toBe('2027-01-01');
    p114eval();
    $this->travel(60)->seconds();
    p114eval();
    expect(Alert::query()->sole()->state)->toBe('resolved');
    expect(DB::table('uptime_results')->where('check_id', $c->id)->count())->toBe(4);

    // API: % uptime, kết quả, Portal của chủ website; USER khác 404.
    $sa = $a->spa('SA');
    $l = $sa->get('/api/v1/admin/uptime-checks');
    assertMatchesContract(P114A, 'get', '/api/v1/admin/uptime-checks', 200, $l);
    expect($l->json('data.0'))->toMatchArray(['state' => 'up', 'uptime_24h' => 25, 'url' => 'https://anphat.vn/']);
    $r = $sa->get("/api/v1/admin/uptime-checks/{$c->uuid}/results?limit=3");
    assertMatchesContract(P114A, 'get', '/api/v1/admin/uptime-checks/{id}/results', 200, $r);
    expect($r->json('data'))->toHaveCount(3)->and($r->json('data.0.ok'))->toBeTrue()->and($r->json('meta.next_cursor'))->toBeString();
    $owner = $a->spa('US_OWNER');
    $p = $owner->get("/api/v1/portal/websites/{$w->uuid}/uptime");
    assertMatchesContract(P114P, 'get', '/api/v1/portal/websites/{id}/uptime', 200, $p);
    $pl = $owner->get("/api/v1/portal/hosting-accounts/{$a->account->uuid}/uptime");
    assertMatchesContract(P114P, 'get', '/api/v1/portal/hosting-accounts/{id}/uptime', 200, $pl);
    $pr = $owner->get("/api/v1/portal/websites/{$w->uuid}/uptime/results");
    assertMatchesContract(P114P, 'get', '/api/v1/portal/websites/{id}/uptime/results', 200, $pr);
    $u = $owner->call('PATCH', "/api/v1/portal/websites/{$w->uuid}/uptime", ['path' => '/health?x=1', 'keyword' => 'OK'], ['If-Match' => $p->headers->get('ETag')]);
    assertMatchesContract(P114P, 'patch', '/api/v1/portal/websites/{id}/uptime', 200, $u);
    expect($u->json('data'))->toMatchArray(['url' => 'https://anphat.vn/health?x=1', 'state' => 'unknown', 'keyword' => 'OK']);
    expect($owner->call('PATCH', "/api/v1/portal/websites/{$w->uuid}/uptime", ['path' => '/'], ['If-Match' => '"cu"'])->status())->toBe(412);
    foreach (['/../etc', '//evil.vn', '/a%0d%0aX', 'http://evil.vn/', '/a/%2e%2e/b'] as $bad) {
        expect($owner->call('PATCH', "/api/v1/portal/websites/{$w->uuid}/uptime", ['path' => $bad])->status())->toBe(422);
    }
    expect($owner->call('PATCH', "/api/v1/portal/websites/{$w->uuid}/uptime", ['url' => 'http://169.254.169.254/'])->status())->toBe(422);
    expect($a->spa('US_OTHER')->get("/api/v1/portal/websites/{$w->uuid}/uptime")->status())->toBe(404);
});

it('rule: SA CRUD + mặc định không xóa/không đổi metric; ADMIN chỉ đọc; USER không vào được; xem trước', function () {
    $a = new Actors($this);
    p114agent($a);
    p114disk($a, 70.0);
    $sa = $a->spa('SA');
    $l = $sa->get('/api/v1/admin/alert-rules?limit=200');
    assertMatchesContract(P114A, 'get', '/api/v1/admin/alert-rules', 200, $l);
    expect(collect($l->json('data'))->where('is_default', true))->toHaveCount(9);

    $body = ['name' => 'Disk > 60%', 'metric' => 'disk_pct', 'scope_type' => 'server', 'scope_uuid' => $a->server->uuid,
        'operator' => 'gt', 'threshold' => 60, 'for_sec' => 0, 'severity' => 'medium', 'channels' => ['in_app']];
    $pv = $sa->post('/api/v1/admin/alert-rules:preview', $body);
    assertMatchesContract(P114A, 'post', '/api/v1/admin/alert-rules:preview', 200, $pv);
    expect($pv->json('data.matches'))->toBe(1)->and($pv->json('data.resources.0.label'))->toBe($a->server->name)
        ->and(Alert::query()->count())->toBe(0);
    $c = $sa->post('/api/v1/admin/alert-rules', $body);
    assertMatchesContract(P114A, 'post', '/api/v1/admin/alert-rules', 201, $c);
    expect($c->json('data'))->toMatchArray(['scope_uuid' => $a->server->uuid, 'for_sec' => 0, 'repeat_sec' => 14400, 'is_default' => false]);
    expect($sa->post('/api/v1/admin/alert-rules', $body)->status())->toBe(409);
    foreach ([['metric' => 'nope'], ['metric' => 'uptime_down'], ['threshold' => 120], ['channels' => []], ['channels' => ['sms']],
        ['scope_uuid' => '01938a02-0001-7000-8000-00000000dead'], ['evil' => 1]] as $bad) {
        expect($sa->post('/api/v1/admin/alert-rules', ['name' => 'X'.random_int(1, 9999)] + $bad + $body)->status())->toBe(422);
    }
    $id = $c->json('data.uuid');
    $g = $sa->get("/api/v1/admin/alert-rules/$id");
    assertMatchesContract(P114A, 'get', '/api/v1/admin/alert-rules/{id}', 200, $g);
    $p = $sa->call('PATCH', "/api/v1/admin/alert-rules/$id", ['threshold' => 65], ['If-Match' => $g->headers->get('ETag')]);
    assertMatchesContract(P114A, 'patch', '/api/v1/admin/alert-rules/{id}', 200, $p);
    expect($p->json('data.threshold'))->toEqual(65)
        ->and($sa->call('PATCH', "/api/v1/admin/alert-rules/$id", ['threshold' => 70], ['If-Match' => $g->headers->get('ETag')])->status())->toBe(412);

    $def = AlertRule::query()->where('default_key', 'disk')->firstOrFail();
    expect($sa->call('PATCH', "/api/v1/admin/alert-rules/{$def->uuid}", ['threshold' => 85, 'enabled' => false])->json('data'))
        ->toMatchArray(['threshold' => 85, 'enabled' => false])
        ->and($sa->call('PATCH', "/api/v1/admin/alert-rules/{$def->uuid}", ['metric' => 'cpu_pct'])->status())->toBe(409)
        ->and($sa->delete("/api/v1/admin/alert-rules/{$def->uuid}")->status())->toBe(409);

    // Rule đang firing không xóa được; hết firing thì xóa được.
    p114disk($a, 80.0);
    AlertRule::query()->where('uuid', '<>', $id)->update(['enabled' => false]);
    p114eval();
    expect(Alert::query()->where('state', 'firing')->count())->toBe(1)
        ->and($sa->delete("/api/v1/admin/alert-rules/$id")->status())->toBe(409);
    $alerts = $sa->get('/api/v1/admin/alerts?filter[state]=firing');
    assertMatchesContract(P114A, 'get', '/api/v1/admin/alerts', 200, $alerts);
    expect($alerts->json('data'))->toHaveCount(1)->and($alerts->json('data.0.resource'))->toBe(['type' => 'server', 'uuid' => $a->server->uuid]);
    expect($sa->get('/api/v1/admin/alerts?filter[state]=lost')->status())->toBe(422);
    expect($a->spa('AD_IN')->get('/api/v1/admin/alerts')->json('data'))->toHaveCount(1);
    expect($a->spa('AD_OUT')->get('/api/v1/admin/alerts')->json('data'))->toHaveCount(0);
    AlertRule::query()->where('uuid', $id)->update(['enabled' => false]);
    p114eval();
    $d = $sa->delete("/api/v1/admin/alert-rules/$id");
    assertMatchesContract(P114A, 'delete', '/api/v1/admin/alert-rules/{id}', 204, $d);

    // ADMIN: đọc được, không sửa rule (monitoring.manage); USER (realm portal) không gọi được API admin.
    $ad = $a->spa('AD_IN');
    expect($ad->get('/api/v1/admin/alert-rules')->status())->toBe(200)
        ->and($ad->call('PATCH', "/api/v1/admin/alert-rules/{$def->uuid}", ['threshold' => 50])->status())->toBe(403)
        ->and($ad->post('/api/v1/admin/alert-rules', $body + ['name' => 'Y'])->status())->toBe(403);
    $owner = $a->spa('US_OWNER');
    expect($owner->get('/api/v1/admin/alert-rules')->status())->toBeIn([401, 403])
        ->and($owner->call('PATCH', "/api/v1/admin/alert-rules/{$def->uuid}", ['threshold' => 1])->status())->toBeIn([401, 403, 419]);
});

it('uptime admin: tạo theo website trong phạm vi (không nhập URL), trùng → 409, ngoài phạm vi → 422', function () {
    $a = new Actors($this);
    $w = Website::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id,
        'primary_domain' => 'khongssl.vn', 'status' => 'ready']);
    expect(UptimeCheck::query()->count())->toBe(0); // không SSL: không tự bật
    $ad = $a->spa('AD_IN');
    $c = $ad->post('/api/v1/admin/uptime-checks', ['website_uuid' => $w->uuid, 'path' => '/ping', 'interval_sec' => 120]);
    assertMatchesContract(P114A, 'post', '/api/v1/admin/uptime-checks', 201, $c);
    expect($c->json('data'))->toMatchArray(['url' => 'http://khongssl.vn/ping', 'interval_sec' => 120, 'state' => 'unknown']);
    expect($ad->post('/api/v1/admin/uptime-checks', ['website_uuid' => $w->uuid])->status())->toBe(409);
    expect($a->spa('AD_OUT')->post('/api/v1/admin/uptime-checks', ['website_uuid' => $w->uuid])->status())->toBe(422);
    expect($ad->post('/api/v1/admin/uptime-checks', ['website_uuid' => $w->uuid, 'url' => 'http://10.0.0.1/'])->status())->toBe(422);
    $id = $c->json('data.uuid');
    $p = $ad->call('PATCH', "/api/v1/admin/uptime-checks/$id", ['enabled' => false]);
    assertMatchesContract(P114A, 'patch', '/api/v1/admin/uptime-checks/{id}', 200, $p);
    expect($p->json('data.state'))->toBe('paused');
    expect($a->spa('AD_OUT')->call('PATCH', "/api/v1/admin/uptime-checks/$id", ['enabled' => true])->status())->toBe(404);
    assertMatchesContract(P114A, 'delete', '/api/v1/admin/uptime-checks/{id}', 204, $ad->delete("/api/v1/admin/uptime-checks/$id"));
});

it('uptime: rollup giờ cho % 30 ngày (sau khi uptime_results bị drop), prune giữ 7 ngày / 90 ngày', function () {
    $this->travelTo(now()->startOfHour()->addMinutes(30)); // tránh ranh giới giờ
    $a = new Actors($this);
    $w = Website::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id,
        'primary_domain' => 'anphat.vn', 'status' => 'ready', 'ssl_mode' => 'acme']);
    $c = UptimeCheck::query()->sole();
    $svc = app(UptimeService::class);
    $h = now()->utc()->subDays(10)->startOfHour();
    // Rollup cũ (kết quả chi tiết đã bị drop): 10 ngày trước, 3/4 thành công.
    DB::table('uptime_rollups')->insert(['check_id' => $c->id, 'bucket' => $h, 'ok_count' => 3, 'total' => 4, 'avg_latency_ms' => 100]);
    $svc->record($c, ['ok' => true, 'status' => 200, 'duration_ms' => 90], now()->subHours(2));
    $svc->record($c, ['ok' => false, 'status' => 500, 'duration_ms' => 90, 'error' => 'HTTP Internal Server Error'], now()->subMinutes(1));
    expect($svc->rollup())->toBeGreaterThan(0);
    expect($svc->rollup())->toBeGreaterThanOrEqual(1); // chạy lại: idempotent
    expect(DB::table('uptime_rollups')->where('check_id', $c->id)->sum('total'))->toEqual(5); // 4 cũ + 1 giờ đã xong (giờ hiện tại chưa gộp)
    $p = $svc->percentages($c->refresh());
    expect($p['uptime_24h'])->toEqual(50.0)->and($p['uptime_30d'])->toEqual(round(4 * 100 / 6, 2));

    DB::table('uptime_rollups')->insert(['check_id' => $c->id, 'bucket' => now()->utc()->subDays(100)->startOfHour(), 'ok_count' => 1, 'total' => 1]);
    DB::select('SELECT itso_ensure_uptime_partition(?::date)', [now()->utc()->subDays(9)->toDateString()]);
    $this->artisan('itso:metrics-prune')->assertSuccessful();
    $parts = collect(DB::select("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'uptime_results'"))->pluck('relname');
    expect($parts)->not->toContain('uptime_results_'.now()->utc()->subDays(9)->format('Ymd'))
        ->toContain('uptime_results_'.now()->utc()->addDays(2)->format('Ymd'));
    expect(DB::table('uptime_rollups')->where('bucket', '<', now()->subDays(90))->count())->toBe(0);
    expect($w->refresh()->exists)->toBeTrue();
});
