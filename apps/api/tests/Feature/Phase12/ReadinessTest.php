<?php

use App\Models\Agent;
use App\Models\NotificationChannel;
use App\Models\Server;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Tests\Support\Actors;

require_once __DIR__.'/../Phase8/helpers.php';

// Prompt 12.7 (D-115): trang Sẵn sàng production đọc API thật — kiểm tự động chỉ đọc + trạng thái Gate G1–G8 đã ghi.

it('readiness: SUPER_ADMIN xem kiểm tự động + Gate theo contract; ADMIN/USER không xem được', function () {
    $dir = sys_get_temp_dir().'/itso-ready-'.bin2hex(random_bytes(4));
    mkdir($dir, 0o700, true);
    config(['itso.update_state_dir' => $dir]);
    $a = new Actors($this);
    $sa = $a->spa('SA');

    $r = $sa->get('/api/v1/admin/system/readiness');
    assertMatchesContract(P8A, 'get', '/api/v1/admin/system/readiness', 200, $r);
    $checks = collect($r->json('data.checks'))->keyBy('key');
    expect($checks->keys()->all())->toBe(['admin_mfa', 'admin_allowlist', 'backup_immutable', 'backup_recent', 'restore_test',
        'cis_score', 'security_updates', 'update_journal', 'cert_expiry', 'alert_channels', 'agents_online'])
        ->and($checks['admin_allowlist']['status'])->toBe('fail')
        ->and($checks['backup_immutable']['status'])->toBe('fail')
        ->and($checks['restore_test']['detail'])->toBe('Chưa có restore test nào')
        ->and($checks['cis_score']['status'])->toBe('warn')
        ->and($checks['update_journal']['status'])->toBe('pass')
        ->and($checks['alert_channels']['status'])->toBe('fail')
        ->and($checks['agents_online']['status'])->toBe('fail')
        ->and(collect($r->json('data.gate'))->pluck('status')->unique()->all())->toBe(['pending_vm'])
        ->and($r->json('data.ready'))->toBeFalse();
    $before = $r->json('data.score');

    // Dữ liệu thay đổi → kiểm đổi theo; journal dở → fail; ghi Gate → pass + verified_at.
    DB::table('ip_allowlist')->insert(['scope' => 'admin', 'cidr' => '127.0.0.0/8', 'note' => 'máy test']);
    NotificationChannel::query()->create(['type' => 'email', 'name' => 'ops', 'config' => ['to' => ['ops@example.test']], 'enabled' => true]);
    foreach (Server::query()->pluck('id') as $sid) { // Actors có server thứ hai (account ngoài phạm vi)
        Agent::query()->create(['server_id' => $sid, 'transport' => 'local', 'last_seen_at' => now()]);
    }
    file_put_contents("$dir/update.journal", json_encode(['version_from' => '1.0.0-rc.1', 'version_to' => '1.0.0', 'step' => 'switched',
        'started_at' => now()->subHour()->toIso8601String()]));
    expect(Artisan::call('itso:gate-record', ['id' => 'G5', 'status' => 'pass', '--note' => 'tests/vm/gate.sh']))->toBe(0)
        ->and(Artisan::call('itso:gate-record', ['id' => 'G9', 'status' => 'pass']))->toBe(1);
    $r = $sa->get('/api/v1/admin/system/readiness');
    assertMatchesContract(P8A, 'get', '/api/v1/admin/system/readiness', 200, $r);
    $checks = collect($r->json('data.checks'))->keyBy('key');
    $g5 = collect($r->json('data.gate'))->firstWhere('id', 'G5');
    expect($checks['admin_allowlist'])->toMatchArray(['status' => 'pass', 'detail' => '1 dải'])
        ->and($checks['alert_channels']['status'])->toBe('pass')
        ->and($checks['agents_online'])->toMatchArray(['status' => 'pass', 'detail' => '2/2 server'])
        ->and($checks['update_journal'])->toMatchArray(['status' => 'fail', 'detail' => 'Journal dở ở bước switched (lên 1.0.0)'])
        ->and($g5['status'])->toBe('pass')->and($g5['verified_at'])->not->toBeNull()
        ->and($r->json('data.score'))->toBeGreaterThan($before);

    $a->spa('AD_IN')->get('/api/v1/admin/system/readiness')->assertStatus(403);
    $a->spa('US_OWNER')->get('/api/v1/admin/system/readiness')->assertStatus(401);
    @unlink("$dir/update.journal");
    @rmdir($dir);
});
