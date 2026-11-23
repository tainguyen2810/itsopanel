<?php

use App\Models\Certificate;
use App\Models\CronJob;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\Job;
use App\Models\SftpAccount;
use App\Models\Website;
use Illuminate\Routing\Route as LaravelRoute;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Str;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

// Prompt 12.4 (ASVS V4, ADR 0055): ma trận quyền sinh tự động từ danh sách route — lưới an toàn thay cho RLS.
//  1. Mọi route ghi của Admin API phải có middleware itso.perm (trừ danh sách ngoại lệ có lý do, guard trong controller).
//  2. Mọi route admin/portal có {id}, gọi bằng actor ngoài phạm vi (ADMIN không được giao server, USER khác) với id
//     THẬT của tài nguyên thuộc account khác → chỉ được 403/404; không bao giờ 2xx, 409, 422 hay 5xx.

/** Route ghi admin không có itso.perm: guard nằm trong controller (wizard cài đặt) hoặc chỉ đụng dữ liệu của chính mình. */
const P12_PERM_EXEMPT = [
    'PATCH api/v1/admin/notification-preferences' => 'tùy chọn thông báo của chính người dùng',
    'POST api/v1/admin/notifications/{id}:read' => 'thông báo của chính người dùng (lọc user_id)',
    'POST api/v1/admin/notifications:read-all' => 'thông báo của chính người dùng',
    'PUT api/v1/admin/setup/access' => 'wizard: SetupController::requireWizardAdmin (SUPER_ADMIN do wizard tạo, đã TOTP)',
    'POST api/v1/admin/setup/admin' => 'wizard: cần phiên đã xác minh mã cài đặt, chỉ một lần',
    'POST api/v1/admin/setup/code:verify' => 'wizard: mã cài đặt một lần, giới hạn tần suất',
    'PUT api/v1/admin/setup/preferences' => 'wizard: cần phiên đã xác minh mã',
    'POST api/v1/admin/setup/restore' => 'wizard: chỉ trước khi tạo SUPER_ADMIN, phiên đã xác minh mã',
    'POST api/v1/admin/setup/restore:inspect' => 'wizard: như trên',
    'POST api/v1/admin/setup/stack:install' => 'wizard: requireWizardAdmin',
    'POST api/v1/admin/setup:complete' => 'wizard: requireWizardAdmin',
];

/** @return list<array{0: string, 1: string, 2: LaravelRoute}> [method, uri, route] của API v1 */
function p12routes(): array
{
    $out = [];
    foreach (Route::getRoutes()->getRoutes() as $r) {
        if (! str_starts_with($r->uri(), 'api/v1/')) {
            continue;
        }
        foreach ($r->methods() as $m) {
            if ($m !== 'HEAD') {
                $out[] = [$m, $r->uri(), $r];
            }
        }
    }

    return $out;
}

it('mọi route ghi của Admin API có itso.perm (trừ ngoại lệ có lý do); ngoại lệ không còn thừa', function () {
    $missing = [];
    $seen = [];
    foreach (p12routes() as [$m, $uri, $r]) {
        if (! str_starts_with($uri, 'api/v1/admin/') || $m === 'GET') {
            continue;
        }
        $key = "$m $uri";
        $hasPerm = collect($r->gatherMiddleware())->contains(fn ($mw) => is_string($mw) && str_starts_with($mw, 'itso.perm:'));
        if ($hasPerm) {
            continue;
        }
        if (isset(P12_PERM_EXEMPT[$key])) {
            $seen[$key] = true;

            continue;
        }
        $missing[] = $key;
    }
    expect($missing)->toBe([])
        ->and(array_diff(array_keys(P12_PERM_EXEMPT), array_keys($seen)))->toBe([]);
});

it('mọi route admin GET (trừ hồ sơ/thông báo của chính mình, thông tin chung và wizard) cũng có itso.perm', function () {
    // Không cần quyền riêng: dữ liệu của chính người dùng, phiên bản/sức khỏe panel (không chứa dữ liệu account),
    // danh mục loại sự kiện thông báo, dashboard (tự lọc theo phạm vi Access::servers/accounts).
    $self = ['api/v1/admin/me', 'api/v1/admin/notifications', 'api/v1/admin/notifications/unread-count', 'api/v1/admin/notification-preferences',
        'api/v1/admin/system/version', 'api/v1/admin/system/status', 'api/v1/admin/notification-events', 'api/v1/admin/dashboard/summary'];
    $missing = [];
    foreach (p12routes() as [$m, $uri, $r]) {
        if ($m !== 'GET' || ! str_starts_with($uri, 'api/v1/admin/') || str_starts_with($uri, 'api/v1/admin/setup')
            || in_array($uri, $self, true)) {
            continue;
        }
        if (! collect($r->gatherMiddleware())->contains(fn ($mw) => is_string($mw) && str_starts_with($mw, 'itso.perm:'))) {
            $missing[] = "GET $uri";
        }
    }
    expect($missing)->toBe([]);
});

it('mọi route có {id}: actor ngoài phạm vi với id thật của account khác chỉ nhận 403/404', function () {
    new FakeAgent(['*' => fn () => ['ok' => true]]);
    $a = new Actors($this);
    $acc = $a->account;
    $site = Website::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $a->server->id, 'primary_domain' => 'matran.vn', 'status' => 'ready']);
    $db = Database::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $a->server->id, 'engine' => 'mariadb',
        'name' => $acc->username.'_mt', 'charset' => 'utf8mb4', 'status' => 'ready']);
    $dbu = DatabaseUser::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $a->server->id, 'engine' => 'mariadb',
        'username' => $acc->username.'_mt', 'host_pattern' => 'localhost', 'status' => 'ready']);
    $cron = CronJob::query()->create(['hosting_account_id' => $acc->id, 'schedule' => '*/5 * * * *', 'command' => 'php cron.php', 'status' => 'ready']);
    $sftp = SftpAccount::query()->create(['hosting_account_id' => $acc->id, 'username' => $acc->username.'_mt', 'status' => 'ready']);
    $cert = Certificate::query()->create(['website_id' => $site->id, 'server_id' => $a->server->id, 'domains' => ['matran.vn'],
        'source' => 'upload', 'status' => 'ready']);
    $job = Job::query()->create(['type' => 'website.create', 'state' => 'succeeded', 'server_id' => $a->server->id,
        'resource_type' => 'website', 'resource_id' => $site->id, 'requested_by_user_id' => $a->owner->id, 'max_attempts' => 1, 'timeout_sec' => 60]);
    $ids = ['servers' => $a->server->uuid, 'hosting-accounts' => $acc->uuid, 'websites' => $site->uuid, 'databases' => $db->uuid,
        'database-users' => $dbu->uuid, 'cron-jobs' => $cron->uuid, 'sftp-accounts' => $sftp->uuid, 'certificates' => $cert->uuid,
        'jobs' => $job->uuid, 'metrics/servers' => $a->server->uuid, 'metrics/hosting-accounts' => $acc->uuid];

    $actors = ['admin' => $a->spa('AD_OUT'), 'portal' => $a->spa('US_OTHER')];
    $bad = [];
    $checked = 0;
    foreach (p12routes() as [$m, $uri, $r]) {
        $seg = explode('/', $uri);
        $realm = $seg[2] ?? '';
        if (! isset($actors[$realm]) || ! str_contains($uri, '{')) {
            continue;
        }
        $first = array_search(true, array_map(fn ($s) => str_starts_with($s, '{'), $seg), true);
        $prefix = implode('/', array_slice($seg, 3, $first - 3));
        $real = $ids[$prefix] ?? (string) Str::uuid();
        // {id} và mọi tham số khác: id thật nếu có, còn lại UUID ngẫu nhiên.
        $path = '/'.preg_replace_callback('/\{([a-z_]+)\??\}/', fn ($mm) => match ($mm[1]) {
            'id' => $real,
            'action' => 'up',
            default => (string) Str::uuid(),
        }, $uri);
        $res = $actors[$realm]->call($m, $path, [], ['Idempotency-Key' => (string) Str::uuid()]);
        $checked++;
        if (! in_array($res->status(), [403, 404], true)) {
            $bad[] = "$m $uri → {$res->status()} ".mb_substr((string) $res->json('code'), 0, 40);
        }
    }
    expect($checked)->toBeGreaterThan(250)->and($bad)->toBe([]);
    // Đối chứng: id là thật — actor trong phạm vi đọc được.
    expect($a->spa('AD_IN')->get("/api/v1/admin/websites/{$site->uuid}")->status())->toBe(200)
        ->and($a->spa('US_OWNER')->get("/api/v1/portal/databases/{$db->uuid}")->status())->toBe(200);
});
