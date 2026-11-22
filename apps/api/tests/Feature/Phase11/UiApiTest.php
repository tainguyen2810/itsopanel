<?php

use App\Domain\Monitoring\DefaultAlertRules;
use App\Models\AlertRule;
use Tests\Support\Actors;

// Prompt 11.7: hành vi API mà giao diện dựa vào (If-Match = "<updated_at>" như bản demo, danh mục kênh cá nhân).

it('If-Match bằng "<updated_at>" (giao diện gửi) được nhận; mốc cũ → 412 — rule cảnh báo, user, tùy chọn thông báo', function () {
    $a = new Actors($this);
    app(DefaultAlertRules::class)->ensure();
    $sa = $a->spa('SA');
    $rule = AlertRule::query()->where('default_key', 'disk')->firstOrFail();
    $g = $sa->get("/api/v1/admin/alert-rules/{$rule->uuid}");
    $at = $g->json('data.updated_at');
    $ok = $sa->call('PATCH', "/api/v1/admin/alert-rules/{$rule->uuid}", ['threshold' => 85], ['If-Match' => "\"$at\""]);
    expect($ok->status())->toBe(200)->and($ok->json('data.threshold'))->toEqual(85);
    $this->travel(2)->seconds();
    $sa->call('PATCH', "/api/v1/admin/alert-rules/{$rule->uuid}", ['threshold' => 86]);
    expect($sa->call('PATCH', "/api/v1/admin/alert-rules/{$rule->uuid}", ['threshold' => 87], ['If-Match' => "\"$at\""])->status())->toBe(412)
        ->and($sa->call('PATCH', "/api/v1/admin/alert-rules/{$rule->uuid}", ['threshold' => 87], ['If-Match' => '"không phải ngày"'])->status())->toBe(412)
        // ETag mạnh vẫn dùng được.
        ->and($sa->call('PATCH', "/api/v1/admin/alert-rules/{$rule->uuid}", ['threshold' => 88],
            ['If-Match' => $sa->get("/api/v1/admin/alert-rules/{$rule->uuid}")->headers->get('ETag')])->status())->toBe(200);

    $u = $sa->get("/api/v1/admin/users/{$a->adminOut->uuid}");
    expect($sa->call('PATCH', "/api/v1/admin/users/{$a->adminOut->uuid}", ['name' => 'Đổi tên'],
        ['If-Match' => '"'.$u->json('data.updated_at').'"'])->status())->toBe(200);

    $p = $a->spa('US_OWNER');
    $pg = $p->get('/api/v1/portal/notification-preferences');
    expect($pg->headers->get('ETag'))->toBe('"'.$pg->json('data.updated_at').'"');
    $body = $pg->json('data');
    $body['events']['quota.warning'] = ['in_app', 'email'];
    $r = $p->call('PATCH', '/api/v1/portal/notification-preferences', $body, ['If-Match' => '"'.$body['updated_at'].'"']);
    expect($r->status())->toBe(200)->and($r->json('data.events')['quota.warning'])->toBe(['in_app', 'email']);
    $this->travel(2)->seconds();
    $p->call('PATCH', '/api/v1/portal/notification-preferences', ['channels' => ['email' => false]]);
    expect($p->call('PATCH', '/api/v1/portal/notification-preferences', $body, ['If-Match' => '"'.$r->json('data.updated_at').'"'])->status())->toBe(412);
});

it('danh mục sự kiện chỉ có kênh cá nhân (không webhook); gửi lại toàn bộ tùy chọn như giao diện được nhận', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $ev = collect($sa->get('/api/v1/admin/notification-events')->json('data'));
    expect($ev->pluck('channels')->flatten()->unique()->sort()->values()->all())->toBe(['email', 'in_app', 'telegram'])
        ->and($ev->firstWhere('type', 'account.unsuspended')['audiences'])->toBe(['user']);
    $prefs = $sa->get('/api/v1/admin/notification-preferences')->json('data');
    $prefs['channels']['telegram'] = false;
    $prefs['events']['alert.firing'] = ['in_app', 'telegram'];
    $r = $sa->call('PATCH', '/api/v1/admin/notification-preferences', $prefs);
    expect($r->status())->toBe(200)->and($r->json('data.channels.telegram'))->toBeFalse()
        ->and($r->json('data.events')['alert.firing'])->toBe(['in_app', 'telegram']);
});
