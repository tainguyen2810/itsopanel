<?php

use App\Domain\Monitoring\AlertEngine;
use App\Domain\Monitoring\DefaultAlertRules;
use App\Domain\Notifications\EmailSender;
use App\Domain\Notifications\NotificationDispatcher;
use App\Domain\Notifications\NotificationSender;
use App\Domain\Notifications\Notifier;
use App\Domain\Notifications\SendFailure;
use App\Domain\Notifications\SsrfGuard;
use App\Domain\Notifications\UserEvents;
use App\Domain\Servers\MetricsCollector;
use App\Jobs\SendNotification;
use App\Models\Agent;
use App\Models\Alert;
use App\Models\AlertRule;
use App\Models\AuditLog;
use App\Models\Certificate;
use App\Models\Job;
use App\Models\Notification;
use App\Models\NotificationChannel;
use App\Models\NotificationDelivery;
use App\Models\Website;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use Tests\Support\Actors;

// Prompt 11.5 (D-103, D-104, ADR 0048/0049): kênh thông báo, SSRF guard, ký HMAC, retry/resend, định tuyến, tùy chọn.

const P115A = 'itso-admin-v1.yaml';
const P115P = 'itso-portal-v1.yaml';
const P115_SECRET = 'hmac-secret-0123456789-abcdef';
const P115_TOKEN = '123456789:AAH-telegram-token-xyz';

/** DNS giả: tên miền nội bộ phân giải ra IP riêng, còn lại ra IP công khai. */
function p115dns(): void
{
    app()->instance(SsrfGuard::class, new SsrfGuard(fn (string $h): array => match ($h) {
        'internal.example.test' => ['10.0.0.5'],
        'rebind.example.test' => ['93.184.216.34', '127.0.0.1'],
        default => ['93.184.216.34'],
    }));
}

/** Email giả: ghi lại người nhận, có thể làm lỗi. */
function p115mail(bool $fail = false): object
{
    $m = new class extends EmailSender
    {
        public array $sent = [];

        public bool $fail = false;

        public function send(array $to, string $subject, string $text): int
        {
            if ($this->fail) {
                throw new SendFailure('SMTP: 421 dịch vụ tạm ngừng', 421);
            }
            $this->sent[] = [$to, $subject, $text];

            return 250;
        }
    };
    $m->fail = $fail;
    app()->instance(EmailSender::class, $m);

    return $m;
}

function p115webhook(Actors $a, string $url, bool $private = false, string $name = 'Webhook'): NotificationChannel
{
    $c = new NotificationChannel(['type' => 'webhook', 'name' => $name, 'config' => ['url' => $url, 'allow_private_network' => $private],
        'enabled' => true]);
    $c->setSecret(P115_SECRET);
    $c->save();

    return $c->refresh();
}

it('SA tạo/sửa/xóa kênh; bí mật không có trong response, audit, delivery; If-Match; ADMIN và USER không quản lý được', function () {
    $a = new Actors($this);
    p115dns();
    Http::fake(['hooks.example.test/*' => Http::response('ok', 200)]);
    $sa = $a->spa('SA');
    $r = $sa->post('/api/v1/admin/notification-channels', ['type' => 'webhook', 'name' => 'Webhook trực ca',
        'config' => ['url' => 'https://hooks.example.test/itso'], 'secret' => P115_SECRET]);
    assertMatchesContract(P115A, 'post', '/api/v1/admin/notification-channels', 201, $r);
    expect($r->json('data'))->toMatchArray(['type' => 'webhook', 'secret_set' => true, 'last_delivery' => null])
        ->and($r->getContent())->not->toContain(P115_SECRET);
    $uuid = $r->json('data.uuid');
    // Thiếu secret / http:// không bật mạng riêng / tên trùng.
    expect($sa->post('/api/v1/admin/notification-channels', ['type' => 'webhook', 'name' => 'X', 'config' => ['url' => 'https://a.example.test/']])->status())->toBe(422)
        ->and($sa->post('/api/v1/admin/notification-channels', ['type' => 'webhook', 'name' => 'X', 'secret' => P115_SECRET,
            'config' => ['url' => 'http://a.example.test/']])->status())->toBe(422)
        ->and($sa->post('/api/v1/admin/notification-channels', ['type' => 'webhook', 'name' => 'X', 'secret' => P115_SECRET,
            'config' => ['url' => 'https://127.0.0.1/x', 'allow_private_network' => true]])->status())->toBe(422)
        ->and($sa->post('/api/v1/admin/notification-channels', ['type' => 'webhook', 'name' => 'X', 'secret' => P115_SECRET,
            'config' => ['url' => 'https://169.254.169.254/latest']])->status())->toBe(422)
        ->and($sa->post('/api/v1/admin/notification-channels', ['type' => 'webhook', 'name' => 'X', 'secret' => P115_SECRET,
            'config' => ['url' => 'https://10.1.2.3/x']])->status())->toBe(422)
        ->and($sa->post('/api/v1/admin/notification-channels', ['type' => 'telegram', 'name' => 'TG', 'secret' => P115_TOKEN,
            'config' => ['chat_id' => 'abc']])->status())->toBe(422)
        ->and($sa->post('/api/v1/admin/notification-channels', ['type' => 'email', 'name' => 'Webhook trực ca',
            'config' => ['recipients' => ['ops@itso.vn']]])->status())->toBe(409);
    $em = $sa->post('/api/v1/admin/notification-channels', ['type' => 'email', 'name' => 'Nhóm vận hành',
        'config' => ['recipients' => ['ops@itso.vn', 'noc@itso.vn']]]);
    expect($em->status())->toBe(201)->and($em->json('data.secret_set'))->toBeFalse();

    $l = $sa->get('/api/v1/admin/notification-channels');
    assertMatchesContract(P115A, 'get', '/api/v1/admin/notification-channels', 200, $l);
    expect($l->json('data'))->toHaveCount(2)->and($l->getContent())->not->toContain(P115_SECRET);

    expect($sa->call('PATCH', "/api/v1/admin/notification-channels/$uuid", ['enabled' => false], ['If-Match' => '"cu"'])->status())->toBe(412);
    $u = $sa->call('PATCH', "/api/v1/admin/notification-channels/$uuid", ['name' => 'Webhook mới', 'secret' => 'secret-moi-0123456789'],
        ['If-Match' => $r->headers->get('ETag')]);
    assertMatchesContract(P115A, 'patch', '/api/v1/admin/notification-channels/{id}', 200, $u);
    expect($u->json('data.name'))->toBe('Webhook mới')->and($u->getContent())->not->toContain('secret-moi-0123456789');

    $t = $sa->post("/api/v1/admin/notification-channels/$uuid:test");
    assertMatchesContract(P115A, 'post', '/api/v1/admin/notification-channels/{id}:test', 200, $t);
    expect($t->json('data'))->toMatchArray(['state' => 'sent', 'response_code' => 200, 'event_type' => 'channel.test']);

    // ADMIN (không có monitoring.manage) và USER không quản lý kênh.
    expect($a->spa('AD_IN')->post('/api/v1/admin/notification-channels', ['type' => 'email', 'name' => 'Y',
        'config' => ['recipients' => ['a@itso.vn']]])->status())->toBe(403)
        ->and($a->spa('AD_IN')->get('/api/v1/admin/notification-deliveries')->status())->toBe(403)
        ->and($a->spa('US_OWNER')->get('/api/v1/admin/notification-channels')->status())->toBeIn([401, 403]);

    // Bí mật không nằm trong audit, delivery, payload.
    $audit = json_encode(AuditLog::query()->where('action', 'like', 'notification_channel.%')->get()->toArray());
    expect($audit)->not->toContain(P115_SECRET)->not->toContain('secret-moi-0123456789')->toContain('[REDACTED]');
    $rows = json_encode(DB::table('notification_deliveries')->get()->toArray());
    expect($rows)->not->toContain(P115_SECRET)->not->toContain('secret-moi-0123456789');
    expect(DB::table('notification_channels')->where('uuid', $uuid)->value('secret_encrypted'))->not->toContain('secret-moi');

    expect($sa->delete("/api/v1/admin/notification-channels/$uuid")->status())->toBe(204)
        ->and(NotificationChannel::query()->where('uuid', $uuid)->exists())->toBeFalse()
        ->and(NotificationDelivery::query()->count())->toBe(0);
});

it('SSRF guard khi gửi (kênh đã lưu trước, DNS đổi): 127.0.0.1, 169.254.169.254, tên miền ra IP riêng → blocked, không gửi; bật mạng riêng → gửi', function () {
    $a = new Actors($this);
    p115dns();
    Http::fake(['*' => Http::response('ok', 200)]);
    $sa = $a->spa('SA');
    foreach ([
        'https://127.0.0.1/hook' => 'loopback',
        'https://169.254.169.254/latest/meta-data/' => 'metadata',
        'https://[::1]/hook' => 'v6 loopback',
        'https://[::ffff:127.0.0.1]/hook' => 'v4-mapped',
        'https://0.0.0.0/hook' => 'zero',
        'https://internal.example.test/hook' => 'dns private',
        'https://rebind.example.test/hook' => 'một IP xấu trong DNS',
    ] as $url => $why) {
        $c = p115webhook($a, $url, false, "W $why");
        $t = $sa->post("/api/v1/admin/notification-channels/{$c->uuid}:test");
        expect($t->status())->toBe(200)
            ->and($t->json('data.state'))->toBe('blocked', $why)
            ->and($t->json('data.attempts'))->toBe(1)
            ->and($t->json('data.error'))->not->toBeNull();
    }
    // Loopback/link-local vẫn chặn khi bật mạng riêng; dải riêng được phép.
    $c = p115webhook($a, 'http://169.254.169.254/', true, 'W meta private');
    expect($sa->post("/api/v1/admin/notification-channels/{$c->uuid}:test")->json('data.state'))->toBe('blocked');
    Http::assertNothingSent();
    $ok = p115webhook($a, 'http://internal.example.test/hook', true, 'W private on');
    expect($sa->post("/api/v1/admin/notification-channels/{$ok->uuid}:test")->json('data.state'))->toBe('sent');
    Http::assertSentCount(1);
    // Không thử lại lượt bị chặn; nhật ký lọc theo state.
    $f = $sa->get('/api/v1/admin/notification-deliveries?filter[delivery_state]=blocked');
    assertMatchesContract(P115A, 'get', '/api/v1/admin/notification-deliveries', 200, $f);
    expect($f->json('data'))->toHaveCount(8)
        ->and(NotificationDelivery::query()->where('state', 'retrying')->count())->toBe(0);
    expect(SsrfGuard::classify('100.64.1.1'))->toBe('private')->and(SsrfGuard::classify('fd00::1'))->toBe('private')
        ->and(SsrfGuard::classify('fe80::1'))->toBe('always')->and(SsrfGuard::classify('224.0.0.1'))->toBe('always')
        ->and(SsrfGuard::classify('8.8.8.8'))->toBeNull()->and(SsrfGuard::classify('2606:4700::1111'))->toBeNull();
});

it('webhook ký HMAC(secret, timestamp.body), không theo redirect, giới hạn thời gian', function () {
    $a = new Actors($this);
    p115dns();
    $seen = null;
    $redirect = false;
    Http::fake(function (HttpRequest $r) use (&$seen, &$redirect) {
        $seen = $r;

        return $redirect ? Http::response('', 302, ['Location' => 'http://169.254.169.254/']) : Http::response('{"ok":true}', 200);
    });
    $c = p115webhook($a, 'https://hooks.example.test/itso');
    $d = app(NotificationDispatcher::class)->toChannel($c, 'alert.firing', 'Disk 95%', 'srv-01 disk 95%', 'high', '/monitoring/alerts');
    expect($d->refresh()->state)->toBe('sent')->and($seen)->not->toBeNull();
    $ts = $seen->header('X-ITSO-Timestamp')[0];
    $sig = $seen->header('X-ITSO-Signature')[0];
    expect($sig)->toBe('sha256='.hash_hmac('sha256', $ts.'.'.$seen->body(), P115_SECRET))
        ->and(abs((int) $ts - now()->getTimestamp()))->toBeLessThan(5)
        ->and(json_decode($seen->body(), true))->toMatchArray(['event' => 'alert.firing', 'title' => 'Disk 95%', 'severity' => 'high',
            'delivery' => $d->uuid])
        ->and($seen->body())->not->toContain(P115_SECRET);
    // Redirect không được theo: 302 → failed, không thử lại.
    $redirect = true;
    $d2 = app(NotificationDispatcher::class)->toChannel($c, 'alert.firing', 'Lần 2', '', 'high');
    expect($d2->refresh()->state)->toBe('failed')->and($d2->response_code)->toBe(302)->and($d2->attempts)->toBe(1);
});

it('kênh lỗi → thử lại 3 lần (1/5/15 phút) rồi failed; gửi lại được; lượt đã gửi không gửi lại; Telegram không lộ token', function () {
    $a = new Actors($this);
    p115dns();
    $up = false;
    Http::fake(function (HttpRequest $r) use (&$up) {
        if (str_contains($r->url(), 'api.telegram.org')) {
            return Http::response(['ok' => false, 'description' => 'Unauthorized'], 401);
        }

        return $up ? Http::response('ok', 200) : Http::response('boom', 500);
    });
    $c = p115webhook($a, 'https://hooks.example.test/fail');
    $d = app(NotificationDispatcher::class)->toChannel($c, 'backup.failed', 'Backup lỗi', 'chi tiết', 'high');
    $d->refresh();
    expect($d->state)->toBe('failed')->and($d->attempts)->toBe(4)->and($d->response_code)->toBe(500)->and($d->error)->toContain('HTTP 500');
    $sa = $a->spa('SA');
    $up = true;
    $r = $sa->post("/api/v1/admin/notification-deliveries/{$d->uuid}:resend");
    assertMatchesContract(P115A, 'post', '/api/v1/admin/notification-deliveries/{id}:resend', 200, $r);
    expect($r->json('data.uuid'))->not->toBe($d->uuid)->and($r->json('data.channel.uuid'))->toBe($c->uuid);
    $new = NotificationDelivery::query()->where('uuid', $r->json('data.uuid'))->sole();
    expect($new->state)->toBe('sent')->and($new->resend_of_id)->toBe($d->id);
    expect($sa->post("/api/v1/admin/notification-deliveries/{$new->uuid}:resend")->status())->toBe(409);

    // Telegram 401: không thử lại, lỗi không chứa token (URL Bot API có token).
    $tg = new NotificationChannel(['type' => 'telegram', 'name' => 'TG', 'config' => ['chat_id' => '-1001234567890'], 'enabled' => true]);
    $tg->setSecret(P115_TOKEN);
    $tg->save();
    $td = app(NotificationDispatcher::class)->toChannel($tg, 'security.high', 'Bảo mật', 'x', 'critical');
    expect($td->refresh()->state)->toBe('failed')->and($td->attempts)->toBe(1)->and($td->error)->toContain('401')
        ->and(json_encode(DB::table('notification_deliveries')->get()))->not->toContain(P115_TOKEN)
        ->and($sa->get('/api/v1/admin/notification-deliveries')->getContent())->not->toContain(P115_TOKEN);
    Http::assertSent(fn (HttpRequest $r) => str_contains($r->url(), 'api.telegram.org/bot') && $r['chat_id'] === '-1001234567890');
});

it('giới hạn 30 tin/phút/kênh: phần vượt blocked rồi gộp thành một tin tóm tắt', function () {
    $a = new Actors($this);
    p115dns();
    Http::fake(['*' => Http::response('ok', 200)]);
    $c = p115webhook($a, 'https://hooks.example.test/rate');
    $disp = app(NotificationDispatcher::class);
    for ($i = 1; $i <= 34; $i++) {
        $disp->toChannel($c, 'alert.firing', "Tin $i", '', $i === 33 ? 'critical' : 'high');
    }
    expect(NotificationDelivery::query()->where('state', 'sent')->count())->toBe(30)
        ->and(NotificationDelivery::query()->where('state', 'blocked')->where('error', NotificationDispatcher::RATE_LIMITED)->count())->toBe(4);
    $this->travel(10)->seconds();
    $this->artisan('itso:notifications-tick')->assertSuccessful();
    $sum = NotificationDelivery::query()->where('event_type', 'notification.summary')->sole();
    expect($sum->state)->toBe('sent')->and($sum->severity)->toBe('critical')->and($sum->title)->toContain('4 thông báo')
        ->and($sum->payload['body'])->toContain('Tin 31')->toContain('Tin 34');
    $this->artisan('itso:notifications-tick')->assertSuccessful();
    expect(NotificationDelivery::query()->where('event_type', 'notification.summary')->count())->toBe(1);
});

it('định tuyến: ADMIN chỉ nhận sự kiện trong phạm vi; USER chủ nhận sự kiện của mình; email cá nhân theo tùy chọn', function () {
    $a = new Actors($this);
    $mail = p115mail();
    $events = app(UserEvents::class);
    $events->backupFailed(new Job(['server_id' => $a->server->id, 'uuid' => (string) Str::uuid(), 'error_message' => 'repo khóa']),
        $a->account->id);
    $to = Notification::query()->where('type', 'backup.failed')->pluck('user_id')->all();
    expect($to)->toContain($a->sa->id, $a->adminIn->id, $a->owner->id)->not->toContain($a->adminOut->id, $a->otherUser->id);
    $own = Notification::query()->where('type', 'backup.failed')->where('user_id', $a->owner->id)->sole();
    expect($own->data['link'])->toBe('/backups');
    expect($mail->sent)->toBe([]); // mặc định chỉ in-app

    // USER bật email cho quota.warning qua Portal; tắt in-app; quota 85 % → email + không in-app.
    $p = $a->spa('US_OWNER');
    $g = $p->get('/api/v1/portal/notification-preferences');
    assertMatchesContract(P115P, 'get', '/api/v1/portal/notification-preferences', 200, $g);
    expect(array_keys($g->json('data.channels')))->toBe(['in_app', 'email']);
    $u = $p->call('PATCH', '/api/v1/portal/notification-preferences', ['events' => ['quota.warning' => ['email']]],
        ['If-Match' => $g->headers->get('ETag')]);
    assertMatchesContract(P115P, 'patch', '/api/v1/portal/notification-preferences', 200, $u);
    expect($u->json('data.events')['quota.warning'])->toBe(['email']);
    $events->quota($a->account, 85.0);
    $events->quota($a->account, 90.0); // cùng mức → không báo lại
    expect($mail->sent)->toHaveCount(1)->and($mail->sent[0][0])->toBe([$a->owner->email])
        ->and(Notification::query()->where('type', 'quota.warning')->where('user_id', $a->owner->id)->count())->toBe(0)
        ->and(Notification::query()->where('type', 'quota.warning')->where('user_id', $a->sa->id)->count())->toBe(1);
    $d = NotificationDelivery::query()->where('recipient_user_id', $a->owner->id)->sole();
    expect($d->state)->toBe('sent')->and($d->response_code)->toBe(250)->and($d->channel_id)->toBeNull();
    $events->quota($a->account, 100.0);
    expect(Notification::query()->where('type', 'quota.exceeded')->where('user_id', $a->owner->id)->count())->toBe(1);

    // USER: không chọn được telegram/webhook, không có sự kiện chỉ của admin; critical luôn in-app (admin).
    expect($p->call('PATCH', '/api/v1/portal/notification-preferences', ['events' => ['quota.warning' => ['telegram']]])->status())->toBe(422)
        ->and($p->call('PATCH', '/api/v1/portal/notification-preferences', ['events' => ['security.high' => ['in_app']]])->status())->toBe(422)
        ->and($p->call('PATCH', '/api/v1/portal/notification-preferences', ['channels' => ['telegram' => true]])->status())->toBe(422);
    $ev = $p->get('/api/v1/portal/notification-events');
    assertMatchesContract(P115P, 'get', '/api/v1/portal/notification-events', 200, $ev);
    $types = collect($ev->json('data'))->pluck('type');
    expect($types)->toContain('website.down', 'quota.warning', 'account.suspended')->not->toContain('security.high', 'alert.firing');
    expect(collect($ev->json('data'))->pluck('channels')->flatten()->unique()->sort()->values()->all())->toBe(['email', 'in_app']);

    $sa = $a->spa('SA');
    $ae = $sa->get('/api/v1/admin/notification-events');
    assertMatchesContract(P115A, 'get', '/api/v1/admin/notification-events', 200, $ae);
    expect(collect($ae->json('data'))->firstWhere('type', 'security.high'))->toMatchArray(['in_app_locked' => true, 'severity' => 'critical']);
    $ag = $sa->get('/api/v1/admin/notification-preferences');
    assertMatchesContract(P115A, 'get', '/api/v1/admin/notification-preferences', 200, $ag);
    expect($sa->call('PATCH', '/api/v1/admin/notification-preferences', ['events' => ['security.high' => ['email']]])->status())->toBe(422);
    $ap = $sa->call('PATCH', '/api/v1/admin/notification-preferences', ['channels' => ['in_app' => false], 'events' => ['security.high' => ['in_app', 'email']]]);
    assertMatchesContract(P115A, 'patch', '/api/v1/admin/notification-preferences', 200, $ap);
    app(Notifier::class)->notify($a->sa, 'security.ssh_bruteforce', 'Bảo mật: brute force', 'x', 'critical');
    app(Notifier::class)->notify($a->sa, 'job.failed', 'Job lỗi', 'x', 'high');
    expect(Notification::query()->where('user_id', $a->sa->id)->where('type', 'security.ssh_bruteforce')->count())->toBe(1) // locked
        ->and(Notification::query()->where('user_id', $a->sa->id)->where('type', 'job.failed')->count())->toBe(0) // in-app tắt
        ->and(collect($mail->sent)->pluck(0)->flatten()->all())->toContain($a->sa->email);
});

it('sự kiện USER: website down/up, account khóa/mở, chứng chỉ 14/7/1 ngày (mỗi mốc một lần), cảnh báo rule đi qua kênh', function () {
    $a = new Actors($this);
    $events = app(UserEvents::class);
    $events->accountState($a->account, true);
    $events->accountState($a->account, false);
    expect(Notification::query()->where('user_id', $a->owner->id)->whereIn('type', ['account.suspended', 'account.unsuspended'])->count())->toBe(2);

    $w = Website::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id,
        'primary_domain' => 'anphat.vn', 'status' => 'ready']);
    $cert = Certificate::query()->create(['website_id' => $w->id, 'server_id' => $a->server->id, 'domains' => [$w->primary_domain],
        'source' => 'acme', 'status' => 'ready', 'not_after' => now()->addDays(13)->addHours(2)]);
    $this->artisan('itso:certificates-expiry')->assertSuccessful();
    $this->artisan('itso:certificates-expiry')->assertSuccessful(); // cùng mốc 14 → không báo lại
    expect(Notification::query()->where('user_id', $a->owner->id)->where('type', 'certificate.expiring')->count())->toBe(1);
    $this->travel(7)->days();
    $this->artisan('itso:certificates-expiry')->assertSuccessful(); // còn 6 ngày → mốc 7
    expect(Notification::query()->where('user_id', $a->owner->id)->where('type', 'certificate.expiring')->count())->toBe(2)
        ->and(Notification::query()->where('user_id', $a->adminOut->id)->count())->toBe(0);
    $this->travelBack();

    // Rule cảnh báo có kênh webhook → delivery gắn alert; email nhóm cũng nhận.
    p115dns();
    $mail = p115mail();
    Http::fake(['*' => Http::response('ok', 200)]);
    $hook = p115webhook($a, 'https://hooks.example.test/alerts');
    $grp = NotificationChannel::query()->create(['type' => 'email', 'name' => 'Ops', 'config' => ['recipients' => ['ops@itso.vn']], 'enabled' => true]);
    Agent::query()->create(['server_id' => $a->server->id, 'transport' => 'local', 'last_seen_at' => now()]);
    app(DefaultAlertRules::class)->ensure();
    $rule = AlertRule::query()->where('default_key', 'disk')->firstOrFail();
    $rule->channels = ['in_app', 'webhook', 'email'];
    $rule->duration_sec = 0;
    $rule->save();
    AlertRule::query()->whereKeyNot($rule->id)->update(['enabled' => false]);
    app(MetricsCollector::class)->insertSamples($a->server->id, null, ['disk_pct' => 97.0], now());
    app(AlertEngine::class)->evaluate();
    $al = Alert::query()->sole();
    expect(NotificationDelivery::query()->where('alert_id', $al->id)->where('channel_id', $hook->id)->value('state'))->toBe('sent')
        ->and(NotificationDelivery::query()->where('alert_id', $al->id)->where('channel_id', $grp->id)->value('state'))->toBe('sent')
        ->and(collect($mail->sent)->pluck(0)->all())->toContain(['ops@itso.vn'])
        ->and(Notification::query()->where('type', 'alert.firing')->where('user_id', $a->owner->id)->count())->toBe(0);
    $ch = $a->spa('SA')->get('/api/v1/admin/notification-channels');
    expect(collect($ch->json('data'))->firstWhere('uuid', $hook->uuid)['last_delivery']['state'])->toBe('sent');
});

it('lịch thử lại: 1, 5, 15 phút rồi failed; job vào queue notifications có delay', function () {
    $a = new Actors($this);
    p115dns();
    Http::fake(['*' => Http::response('boom', 503)]);
    Queue::fake();
    $c = p115webhook($a, 'https://hooks.example.test/fail');
    $d = app(NotificationDispatcher::class)->toChannel($c, 'alert.firing', 'Lịch', '', 'high');
    Queue::assertPushedOn('notifications', SendNotification::class);
    $sender = app(NotificationSender::class);
    $steps = [];
    for ($i = 0; $i < 4; $i++) {
        $x = $sender->attempt($d->id);
        $steps[] = $x->state === 'retrying' ? (int) round(now()->diffInMinutes($x->next_retry_at, true)) : $x->state;
    }
    expect($steps)->toBe([1, 5, 15, 'failed'])->and($d->refresh()->attempts)->toBe(4);
    Queue::assertPushed(SendNotification::class, 4); // 1 lần đầu + 3 lần thử lại
    // Lượt đến hạn bị mất job → tick đưa lại vào queue.
    $lost = NotificationDelivery::query()->create(['channel_id' => $c->id, 'event_type' => 'x', 'severity' => 'info', 'title' => 'mất',
        'state' => 'retrying', 'next_retry_at' => now()->subMinutes(3)]);
    $this->artisan('itso:notifications-tick')->assertSuccessful();
    Queue::assertPushed(SendNotification::class, fn ($j) => $j->deliveryId === $lost->id);
});
