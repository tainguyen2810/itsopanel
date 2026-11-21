<?php

use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use Illuminate\Support\Str;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

/*
 * Ma trận quyền tự động (Prompt 3.3): mỗi endpoint × nhân vật.
 * SA = SUPER_ADMIN; AD_IN = ADMIN có phạm vi server chứa account của US_OWNER; AD_OUT = ADMIN không phạm vi;
 * US_OWNER = USER Portal chủ account: không có phiên admin nên GET → 401, ghi → 419 (chặn ở CSRF trước xác thực). Ngoài phạm vi → 404, thiếu quyền → 403.
 * {owner} = uuid USER chủ account, {other} = uuid ADMIN ngoài phạm vi.
 * Prompt 3.4/3.5/4.5 bổ sung endpoint mới vào bảng này.
 */
const MATRIX = [
    // [method, path, body, SA, AD_IN, AD_OUT, US_OWNER]
    ['GET', '/api/v1/admin/users/{owner}', null, 200, 200, 404, 401],
    ['PATCH', '/api/v1/admin/users/{owner}', ['name' => 'Ten Moi'], 200, 200, 404, 419],
    ['POST', '/api/v1/admin/users/{owner}:lock', [], 200, 200, 404, 419],
    ['POST', '/api/v1/admin/users/{owner}:unlock', [], 200, 200, 404, 419],
    ['POST', '/api/v1/admin/users/{owner}:reset-mfa', [], 200, 200, 404, 419],
    ['POST', '/api/v1/admin/users/{owner}:impersonate', ['reason' => 'Hỗ trợ khách hàng'], 201, 403, 403, 419],
    ['GET', '/api/v1/admin/users/{owner}/scopes', null, 200, 200, 404, 401],
    ['PUT', '/api/v1/admin/users/{other}/scopes', ['scopes' => []], 200, 403, 403, 419],
    ['GET', '/api/v1/admin/users/{other}', null, 200, 404, 200, 401],
    ['PATCH', '/api/v1/admin/users/{other}', ['name' => 'Ten Moi'], 200, 404, 403, 419],
    ['POST', '/api/v1/admin/users', ['realm' => 'portal', 'name' => 'Moi', 'email' => 'moi@example.vn', 'role' => 'USER'], 201, 201, 201, 419],
    ['POST', '/api/v1/admin/users', ['realm' => 'admin', 'name' => 'Moi', 'email' => 'moi@example.vn', 'role' => 'ADMIN'], 201, 403, 403, 419],
    ['GET', '/api/v1/admin/users', null, 200, 200, 200, 401],
    ['GET', '/api/v1/admin/roles', null, 200, 200, 200, 401],
    ['GET', '/api/v1/admin/api-tokens', null, 200, 403, 403, 401],
    ['POST', '/api/v1/admin/api-tokens', ['name' => 'ci', 'scopes' => ['users:read'], 'expires_at' => '+1 month'], 201, 403, 403, 419],
    ['GET', '/api/v1/admin/system/version', null, 200, 200, 200, 401],
    // 3.4: job, audit, thông báo, cài đặt, server, dashboard ({server} = server chứa account của US_OWNER)
    ['GET', '/api/v1/admin/jobs', null, 200, 200, 200, 401],
    ['GET', '/api/v1/admin/audit-logs', null, 200, 200, 200, 401],
    ['GET', '/api/v1/admin/audit-logs/export', null, 200, 403, 403, 401],
    ['GET', '/api/v1/admin/notifications', null, 200, 200, 200, 401],
    ['POST', '/api/v1/admin/notifications:read-all', [], 204, 204, 204, 419],
    ['GET', '/api/v1/admin/settings/general', null, 200, 403, 403, 401],
    ['PATCH', '/api/v1/admin/settings/general', ['panel_name' => 'ITSO'], 200, 403, 403, 419],
    ['GET', '/api/v1/admin/servers', null, 200, 200, 200, 401],
    ['GET', '/api/v1/admin/servers/{server}', null, 200, 200, 404, 401],
    ['PATCH', '/api/v1/admin/servers/{server}', ['accepting_new_accounts' => false], 200, 403, 403, 419],
    ['GET', '/api/v1/admin/dashboard/summary', null, 200, 200, 200, 401],
    // 3.5: gói + account ({account} = account của US_OWNER trên server trong phạm vi AD_IN)
    ['GET', '/api/v1/admin/hosting-packages', null, 200, 200, 200, 401],
    ['POST', '/api/v1/admin/hosting-packages', ['code' => 'ma-tran', 'name' => 'Ma trận', 'limits' => 'LIMITS'], 201, 403, 403, 419],
    ['GET', '/api/v1/admin/hosting-accounts', null, 200, 200, 200, 401],
    ['GET', '/api/v1/admin/hosting-accounts/{account}', null, 200, 200, 404, 401],
    ['GET', '/api/v1/admin/hosting-accounts/{account}/usage', null, 200, 200, 404, 401],
    ['GET', '/api/v1/admin/hosting-accounts/{account}/lifecycle-events', null, 200, 200, 404, 401],
    ['PATCH', '/api/v1/admin/hosting-accounts/{account}', ['legal_hold' => true], 200, 403, 404, 419],
    ['POST', '/api/v1/admin/hosting-accounts/{account}:suspend', ['reason' => 'Kiểm tra ma trận'], 202, 202, 404, 419],
    ['POST', '/api/v1/admin/hosting-accounts/{account}:terminate', ['reason' => 'Kiểm tra ma trận', 'confirm_username' => '{username}'], 202, 403, 403, 419],
    // 4.5: dịch vụ, phần mềm, reboot, dung lượng, số liệu, cập nhật
    ['GET', '/api/v1/admin/servers/{server}/services', null, 200, 200, 404, 401],
    ['POST', '/api/v1/admin/servers/{server}/services/nginx:restart', [], 202, 403, 403, 419],
    ['POST', '/api/v1/admin/servers/{server}:reboot', [], 202, 403, 403, 419],
    ['GET', '/api/v1/admin/servers/{server}/software', null, 200, 200, 404, 401],
    ['POST', '/api/v1/admin/servers/{server}/software/restic:install', [], 202, 403, 403, 419],
    ['GET', '/api/v1/admin/servers/{server}/capacity', null, 200, 200, 404, 401],
    ['GET', '/api/v1/admin/metrics/servers/{server}?metric=cpu_pct&range=1h', null, 200, 200, 404, 401],
    ['GET', '/api/v1/admin/metrics/hosting-accounts/{account}?metric=disk_pct', null, 200, 200, 404, 401],
    ['GET', '/api/v1/admin/system/updates', null, 200, 403, 403, 401],
];

/*
 * Portal: USER chỉ đọc tài nguyên của mình. [method, path, US_OWNER, US_OTHER]; {account} thuộc US_OWNER.
 */
const PORTAL_MATRIX = [
    ['GET', '/api/v1/portal/hosting-accounts/{account}', 200, 404],
    ['GET', '/api/v1/portal/hosting-accounts/{account}/features', 200, 404],
    ['GET', '/api/v1/portal/hosting-accounts/{account}/usage', 200, 404],
    ['GET', '/api/v1/portal/jobs/{job}', 200, 404],
    ['GET', '/api/v1/portal/jobs/{job}/logs', 200, 404],
    ['POST', '/api/v1/portal/jobs/{job}:cancel', 409, 404],
    ['GET', '/api/v1/portal/hosting-accounts', 200, 200],
    ['GET', '/api/v1/portal/overview', 200, 200],
    ['GET', '/api/v1/portal/profile', 200, 200],
    ['GET', '/api/v1/portal/notifications', 200, 200],
];

dataset('matrix', function () {
    $personas = ['SA' => 3, 'AD_IN' => 4, 'AD_OUT' => 5, 'US_OWNER' => 6];
    foreach (MATRIX as $row) {
        foreach ($personas as $p => $col) {
            yield "{$row[0]} {$row[1]} × $p".($row[2]['role'] ?? '') => [$row[0], $row[1], $row[2], $p, $row[$col]];
        }
    }
});

it('ma trận quyền', function (string $method, string $path, ?array $body, string $persona, int $expected) {
    $a = new Actors($this);
    $spa = $a->spa($persona);
    $uri = strtr($path, ['{owner}' => $a->owner->uuid, '{other}' => $a->adminOut->uuid, '{server}' => $a->server->uuid,
        '{account}' => $a->account->uuid]);
    if (($body['limits'] ?? null) === 'LIMITS') {
        $body['limits'] = limits();
    }
    if (($body['confirm_username'] ?? null) === '{username}') {
        $body['confirm_username'] = $a->account->username;
    }
    $headers = preg_match('#/(hosting-accounts/\{account\}|servers/\{server\}|services/[a-z0-9.-]+|software/[a-z0-9.-]+):#', $path) === 1
        ? ['Idempotency-Key' => (string) Str::uuid()] : [];
    new FakeAgent(['*' => fn () => ['ok' => true]]);
    if (isset($body['expires_at'])) {
        $body['expires_at'] = now()->modify($body['expires_at'])->toIso8601String();
    }
    $res = $spa->call($method, $uri, $body ?? [], $headers);
    expect($res->getStatusCode())->toBe($expected, "$method $uri × $persona: ".$res->getContent());
    if ($expected >= 400) {
        expect($res->headers->get('Content-Type'))->toBe('application/problem+json');
    }
})->with('matrix');

it('danh sách user theo phạm vi: AD_IN thấy chủ account, AD_OUT không; không ai ngoài SA thấy USER khác', function () {
    $a = new Actors($this);
    $uuids = fn (string $p) => collect($a->spa($p)->get('/api/v1/admin/users', ['limit' => 200])->json('data'))->pluck('uuid');
    expect($uuids('SA'))->toContain($a->owner->uuid, $a->otherUser->uuid, $a->adminOut->uuid)
        ->and($uuids('AD_IN'))->toContain($a->owner->uuid, $a->adminIn->uuid)->not->toContain($a->otherUser->uuid, $a->adminOut->uuid)
        ->and($uuids('AD_OUT'))->toEqual(collect([$a->adminOut->uuid]));
});

dataset('portal_matrix', function () {
    foreach (PORTAL_MATRIX as $row) {
        yield "{$row[0]} {$row[1]} × US_OWNER" => [$row[0], $row[1], 'US_OWNER', $row[2]];
        yield "{$row[0]} {$row[1]} × US_OTHER" => [$row[0], $row[1], 'US_OTHER', $row[3]];
    }
});

it('ma trận Portal: USER khác nhận 404 với tài nguyên không phải của mình', function (string $method, string $path, string $persona, int $expected) {
    $a = new Actors($this);
    new FakeAgent(['*' => fn () => ['ok' => true]]);
    $spec = (new JobSpec('hosting_account.suspend', $a->account, $a->server->id))
        ->step('account.suspend', ['account' => ['username' => $a->account->username, 'uid' => $a->account->uid], 'reason' => 'ma tran']);
    $job = app(JobDispatcher::class)->dispatch($spec, $a->owner);
    $uri = strtr($path, ['{account}' => $a->account->uuid, '{job}' => $job->uuid]);
    $res = $a->spa($persona)->call($method, $uri);
    expect($res->getStatusCode())->toBe($expected, "$method $uri × $persona: ".$res->getContent());
})->with('portal_matrix');
