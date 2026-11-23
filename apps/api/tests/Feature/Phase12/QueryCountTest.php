<?php

use App\Models\Database;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\User;
use App\Models\Website;
use App\Models\WebsiteDomain;
use Illuminate\Support\Facades\DB;
use Tests\Support\Actors;
use Tests\Support\Spa;

// Prompt 12.5 (ADR 0057 §4): chặn N+1 ở các trang danh sách chính — số truy vấn SQL của một trang không được tăng theo
// số dòng (đo trang 5 dòng và trang 40 dòng; cho phép chênh ≤ 3 cho truy vấn phụ cố định như đếm/khóa).

function p12q(Spa $spa, string $uri): int
{
    DB::flushQueryLog();
    DB::enableQueryLog();
    $res = $spa->get($uri);
    $n = count(DB::getQueryLog());
    DB::disableQueryLog();
    expect($res->status())->toBe(200, "$uri → {$res->status()}");

    return $n;
}

/** Thêm $n account (mỗi account 1 chủ + 1 website + domain + 1 DB + 1 job) trên server của Actors. */
function p12rows(Actors $a, int $n): void
{
    for ($i = 0; $i < $n; $i++) {
        $owner = User::factory()->portalUser()->create(); // mỗi account một chủ → trang users cũng có ≥ 40 dòng
        $acc = HostingAccount::factory()->create(['server_id' => $a->server->id, 'owner_user_id' => $owner->id,
            'package_version_id' => $a->account->package_version_id]);
        $w = Website::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $a->server->id,
            'primary_domain' => "q$i-{$acc->username}.vn", 'status' => 'ready']);
        WebsiteDomain::query()->create(['website_id' => $w->id, 'name' => $w->primary_domain, 'type' => 'primary']);
        Database::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $a->server->id, 'engine' => 'mariadb',
            'name' => $acc->username.'_q', 'charset' => 'utf8mb4', 'status' => 'ready']);
        Job::query()->create(['type' => 'website.update', 'state' => 'succeeded', 'server_id' => $a->server->id,
            'resource_type' => 'website', 'resource_id' => $w->id, 'requested_by_user_id' => $a->sa->id, 'max_attempts' => 1, 'timeout_sec' => 60]);
        DB::table('audit_logs')->insert(['actor_user_id' => $a->sa->id, 'action' => 'website.update', 'resource_type' => 'websites',
            'resource_id' => $w->id, 'server_id' => $a->server->id, 'result' => 'success']);
    }
}

it('danh sách chính không N+1: số truy vấn trang 40 dòng ≈ trang 5 dòng', function () {
    $a = new Actors($this);
    p12rows($a, 45);
    $sa = $a->spa('SA');
    $own = $a->spa('US_OWNER');
    $pages = [
        [$sa, '/api/v1/admin/hosting-accounts'],
        [$sa, '/api/v1/admin/websites'],
        [$sa, '/api/v1/admin/databases'],
        [$sa, '/api/v1/admin/jobs'],
        [$sa, '/api/v1/admin/audit-logs'],
        [$sa, '/api/v1/admin/users'],
        [$sa, '/api/v1/admin/certificates'],
        [$sa, "/api/v1/admin/metrics/servers/{$a->server->uuid}/accounts"],
        [$own, '/api/v1/portal/websites'],
        [$own, '/api/v1/portal/jobs'],
    ];
    $bad = [];
    foreach ($pages as [$spa, $uri]) {
        $small = p12q($spa, "$uri?limit=5");
        $big = p12q($spa, "$uri?limit=40");
        if ($big - $small > 3) {
            $bad[] = "$uri: $small truy vấn (5 dòng) → $big truy vấn (40 dòng)";
        }
    }
    expect($bad)->toBe([]);
});
