<?php

declare(strict_types=1);

namespace App\Domain\System;

use App\Domain\Security\CisService;
use App\Domain\Servers\OsUpdates;
use App\Http\Controllers\Api\V1\SystemController;
use App\Http\Presenters\ServerPresenter;
use App\Models\Agent;
use App\Models\BackupDestination;
use App\Models\BackupSnapshot;
use App\Models\BackupVerification;
use App\Models\Certificate;
use App\Models\HostingAccount;
use App\Models\MfaCredential;
use App\Models\NotificationChannel;
use App\Models\SecuritySetting;
use App\Models\Server;
use App\Models\Setting;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Sẵn sàng production (Prompt 12.7, D-115): kiểm tự động chỉ đọc từ dữ liệu panel + trạng thái Production Gate G1–G8.
 * Trạng thái Gate lấy từ bằng chứng đã ghi (`php artisan itso:gate-record`, settings group `production_gate`); chưa ghi =
 * `pending_vm`. `ready` chỉ true khi mọi kiểm `pass` và mọi bài Gate `pass`.
 */
final class ProductionReadiness
{
    /** id => [tiêu đề, phần đã kiểm tự động trong CI] (khớp docs/gate/G*.md). */
    public const GATE = [
        'G1' => ['Cách ly account trên 2 server', 'Pest ma trận quyền (> 250 route) + Go test đường dẫn/UID: đạt'],
        'G2' => ['Quota disk/inode/CPU/RAM', 'Go test quota trong sandbox: đạt'],
        'G3' => ['Leo thang đặc quyền (webshell, portal, giả định Laravel RCE)', 'Fuzz agent + check-no-exec + ma trận quyền: đạt'],
        'G4' => ['Khôi phục ngẫu nhiên 10 account + 1 sang server khác + immutable', 'Pest backup/restore với agent giả: đạt'],
        'G5' => ['Nâng 3 phiên bản + rollback giữa chừng', 'Go test journal/repair từng bước: đạt'],
        'G6' => ['DR control plane + cả server', 'Pest DR + Go test itso install --restore: đạt'],
        'G7' => ['Chuyển 5 account giữa server', 'Pest chuyển account với agent giả: đạt'],
        'G8' => ['Gỡ cài đặt giữ site/home/DB', 'Go test uninstall giữ dữ liệu hosting: đạt'],
    ];

    public const GATE_STATUSES = ['pass', 'fail', 'partial', 'pending_vm'];

    /** @return array<string, mixed> Readiness */
    public function report(): array
    {
        $servers = Server::query()->orderBy('name')->get()->values();
        $checks = [
            $this->adminMfa(), $this->allowlist(), $this->backupImmutable(), $this->backupRecent(), $this->restoreTest(),
            $this->cis(array_values($servers->all())), $this->securityUpdates(array_values($servers->all())), $this->journal(), $this->certExpiry(),
            $this->channels(), $this->agents(array_values($servers->all())),
        ];
        $gate = $this->gate();
        $pts = array_sum(array_map(fn (array $c): int => ['pass' => 2, 'warn' => 1, 'fail' => 0][$c['status']], $checks));
        $ready = array_filter($checks, fn (array $c): bool => $c['status'] !== 'pass') === []
            && array_filter($gate, fn (array $g): bool => $g['status'] !== 'pass') === [];

        return ['score' => (int) round($pts * 50 / count($checks)), 'ready' => $ready,
            'checked_at' => Carbon::now()->toIso8601String(), 'checks' => $checks, 'gate' => $gate];
    }

    /** Ghi bằng chứng một bài Gate (sau khi chạy tests/vm/gate.sh). */
    public static function record(string $id, string $status, ?string $note = null): void
    {
        $row = Setting::query()->firstOrNew(['group_key' => 'production_gate', 'key' => $id]);
        $row->value = ['status' => $status, 'verified_at' => $status === 'pending_vm' ? null : Carbon::now()->toIso8601String(),
            'note' => $note !== null ? mb_substr($note, 0, 500) : null];
        $row->is_encrypted = false;
        $row->save();
    }

    /** @return list<array<string, mixed>> */
    private function gate(): array
    {
        $rows = Setting::query()->where('group_key', 'production_gate')->get()->keyBy('key');
        $out = [];
        foreach (self::GATE as $id => [$title, $automated]) {
            $v = (array) ($rows->get($id)->value ?? []);
            $st = in_array($v['status'] ?? null, self::GATE_STATUSES, true) ? $v['status'] : 'pending_vm';
            $at = is_string($v['verified_at'] ?? null) ? Carbon::parse($v['verified_at'])->toIso8601String() : null;
            $out[] = ['id' => $id, 'title' => $title, 'status' => $st, 'automated' => $automated,
                'evidence_doc' => "docs/gate/$id.md", 'verified_at' => $at];
        }

        return $out;
    }

    /** @return array<string, mixed> */
    private static function check(string $key, string $group, string $title, string $status, string $detail, ?string $href): array
    {
        return ['key' => $key, 'group' => $group, 'title' => $title, 'status' => $status, 'detail' => $detail, 'href' => $href];
    }

    /** @return array<string, mixed> */
    private function adminMfa(): array
    {
        $admins = User::query()->where('realm', 'admin')->where('status', 'active')->pluck('id');
        $with = MfaCredential::query()->whereIn('user_id', $admins)->where('type', 'totp')->distinct()->count('user_id');
        $n = $admins->count();

        return self::check('admin_mfa', 'access', 'MFA bật cho mọi quản trị viên', $n > 0 && $with >= $n ? 'pass' : 'fail',
            "$with/$n quản trị viên", '/admin/users');
    }

    /** @return array<string, mixed> */
    private function allowlist(): array
    {
        $n = DB::table('ip_allowlist')->where('scope', 'admin')->count();

        return self::check('admin_allowlist', 'access', 'Admin Panel giới hạn theo IP allowlist', $n > 0 ? 'pass' : 'fail',
            $n > 0 ? "$n dải" : 'Chưa có dải nào: Admin Panel mở cho mọi IP', '/admin/security/allowlist');
    }

    /** @return array<string, mixed> */
    private function backupImmutable(): array
    {
        $dests = BackupDestination::query()->get();
        $imm = $dests->filter(fn (BackupDestination $d): bool => $d->immutable())->count();
        $n = $dests->count();
        $st = match (true) {
            $n === 0 || $imm === 0 => 'fail',
            $imm < $n => 'warn',
            default => 'pass',
        };

        return self::check('backup_immutable', 'backup', 'Có đích backup bất biến (append-only/immutable)', $st,
            $n === 0 ? 'Chưa có đích backup' : "$imm/$n đích bất biến", '/admin/backups');
    }

    /** @return array<string, mixed> */
    private function backupRecent(): array
    {
        $accounts = HostingAccount::query()->where('lifecycle_state', 'active')->pluck('id');
        $n = $accounts->count();
        $with = $n === 0 ? 0 : BackupSnapshot::query()->whereIn('hosting_account_id', $accounts)
            ->where('taken_at', '>=', Carbon::now()->subDay())->distinct()->count('hosting_account_id');
        $st = match (true) {
            $n === 0 || $with >= $n => 'pass',
            $with > 0 => 'warn',
            default => 'fail',
        };

        return self::check('backup_recent', 'backup', 'Mọi account có snapshot trong 24 giờ', $st,
            $n === 0 ? 'Chưa có account' : "$with/$n account", '/admin/backups');
    }

    /** @return array<string, mixed> */
    private function restoreTest(): array
    {
        $last = BackupVerification::query()->where('kind', 'restore_test')->where('state', 'succeeded')
            ->orderByDesc('finished_at')->first();
        $at = $last?->finished_at;
        $ok = $at instanceof Carbon && $at->gte(Carbon::now()->subDays(7));

        return self::check('restore_test', 'backup', 'Có restore test thành công trong 7 ngày', $ok ? 'pass' : 'fail',
            $at instanceof Carbon ? 'Lần gần nhất '.(int) $at->diffInDays(Carbon::now(), true).' ngày trước' : 'Chưa có restore test nào',
            '/admin/backups');
    }

    /**
     * @param  list<Server>  $servers
     * @return array<string, mixed>
     */
    private function cis(array $servers): array
    {
        $bad = [];
        $worst = 'pass';
        foreach ($servers as $s) {
            $r = CisService::latest($s->id);
            if ($r === null || $r->score < 80) {
                $bad[] = $s->name.': '.($r === null ? 'chưa quét' : $r->score);
                $worst = $r !== null && $r->score < 60 ? 'fail' : ($worst === 'fail' ? 'fail' : 'warn');
            }
        }

        return self::check('cis_score', 'security', 'Điểm CIS ≥ 80 trên mọi server', $servers === [] ? 'warn' : $worst,
            $servers === [] ? 'Chưa có server' : ($bad === [] ? 'Mọi server ≥ 80' : implode(', ', array_slice($bad, 0, 5))),
            '/admin/security/cis');
    }

    /**
     * @param  list<Server>  $servers
     * @return array<string, mixed>
     */
    private function securityUpdates(array $servers): array
    {
        $bad = [];
        $href = '/admin/servers';
        foreach ($servers as $s) {
            $facts = (array) (SecuritySetting::query()->find($s->id)->audit_facts ?? []);
            $n = max(OsUpdates::get($s)['pending_security'], (int) (((array) ($facts['updates'] ?? []))['pending_security'] ?? 0));
            if ($n > 0) {
                $bad[] = "{$s->name}: $n gói";
                $href = "/admin/servers/{$s->uuid}/software";
            }
        }

        return self::check('security_updates', 'updates', 'Không còn bản vá bảo mật chờ cài', $bad === [] ? 'pass' : 'fail',
            $bad === [] ? 'Không còn gói chờ' : implode(', ', array_slice($bad, 0, 5)), $href);
    }

    /** @return array<string, mixed> */
    private function journal(): array
    {
        $j = SystemController::journal();

        return self::check('update_journal', 'updates', 'Không có update dở dang', $j === null ? 'pass' : 'fail',
            $j === null ? 'Không có journal' : "Journal dở ở bước {$j['step']} (lên {$j['version_to']})", '/admin/system/updates');
    }

    /** @return array<string, mixed> */
    private function certExpiry(): array
    {
        $n = Certificate::query()->where('status', 'ready')->whereNotNull('not_after')
            ->where('not_after', '<', Carbon::now()->addDays(14))->count();

        return self::check('cert_expiry', 'security', 'Không chứng chỉ nào hết hạn trong 14 ngày', $n === 0 ? 'pass' : 'fail',
            "$n chứng chỉ", '/admin/ssl');
    }

    /** @return array<string, mixed> */
    private function channels(): array
    {
        $n = NotificationChannel::query()->where('enabled', true)->count();

        return self::check('alert_channels', 'monitoring', 'Có kênh thông báo ngoài panel hoạt động', $n > 0 ? 'pass' : 'fail',
            $n > 0 ? "$n kênh đang bật" : 'Chưa có kênh nào: cảnh báo chỉ hiện trong panel', '/admin/monitoring/channels');
    }

    /**
     * @param  list<Server>  $servers
     * @return array<string, mixed>
     */
    private function agents(array $servers): array
    {
        $agents = Agent::query()->whereIn('server_id', array_map(fn (Server $s): int => $s->id, $servers) ?: [0])->get()->keyBy('server_id');
        $down = [];
        foreach ($servers as $s) {
            if (ServerPresenter::connection($agents->get($s->id)) !== 'online') {
                $down[] = $s->name;
            }
        }

        return self::check('agents_online', 'monitoring', 'Mọi server đang kết nối', $servers !== [] && $down === [] ? 'pass' : 'fail',
            $servers === [] ? 'Chưa có server' : ($down === [] ? count($servers).'/'.count($servers).' server' : implode(', ', array_slice($down, 0, 5)).' mất kết nối'),
            '/admin/servers');
    }
}
