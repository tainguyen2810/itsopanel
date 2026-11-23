<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Exceptions\ApiProblem;
use App\Models\CisResult;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\Server;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Kiểm CIS Ubuntu 24.04 L1 chỉ đọc (D-109, ADR 0054): job `cis.audit` → `cis_results`; điểm = pass / (pass + fail),
 * `na` không tính. Không tự sửa: mục sửa được trỏ `fix_href` tới recipe sẵn có, mục còn lại có hướng dẫn.
 */
final class CisService
{
    public const PROFILE = 'ubuntu24.04-l1-hosting';

    public const KEEP = 30;

    /** @var array<string, array{0: string, 1: string|null}> id mục → [hướng dẫn sửa, đích sửa trong panel (%s = uuid server)] */
    private const REMEDIATION = [
        '1.1.2.1' => ['Tách /tmp thành phân vùng riêng (hoặc tmpfs) khi cài lại máy.', null],
        '1.1.2.3' => ['Thêm nosuid cho /tmp trong /etc/fstab rồi remount.', null],
        '1.1.2.4' => ['Thêm noexec cho /tmp trong /etc/fstab rồi remount (kiểm tra ứng dụng cần chạy file trong /tmp).', null],
        '1.1.3.1' => ['Tách /var khi cài lại máy; không sửa được tại chỗ an toàn.', null],
        '1.3.1.2' => ['Bật AppArmor (apparmor=1 security=apparmor trong GRUB_CMDLINE_LINUX) rồi khởi động lại.', null],
        '1.3.1.3' => ['Đưa profile AppArmor đang tắt về enforce hoặc complain (aa-enforce / aa-complain).', null],
        '1.5.1' => ['Đặt kernel.randomize_va_space = 2 trong /etc/sysctl.d.', null],
        '1.5.3' => ['Đặt fs.suid_dumpable = 0 trong /etc/sysctl.d.', null],
        '2.1.1' => ['Gỡ hoặc tắt autofs nếu không dùng.', null],
        '2.1.6' => ['Gỡ hoặc tắt dịch vụ NFS nếu không dùng.', null],
        '2.1.12' => ['Tắt rpcbind (systemctl mask rpcbind.socket rpcbind.service) nếu không dùng NFS.', null],
        '2.1.16' => ['Gỡ snmpd nếu không giám sát bằng SNMP.', null],
        '2.1.21' => ['Cho MTA chỉ nghe 127.0.0.1 (inet_interfaces = loopback-only).', null],
        '2.4.1.2' => ['chmod 600 /etc/crontab; chown root:root /etc/crontab.', null],
        '3.3.1' => ['Tắt net.ipv4.ip_forward nếu không chạy Docker; có Docker thì ghi nhận ngoại lệ.', null],
        '3.3.2' => ['Đặt net.ipv4.conf.all.send_redirects = 0.', null],
        '3.3.5' => ['Đặt net.ipv4.conf.all.accept_redirects = 0.', null],
        '3.3.8' => ['Đặt net.ipv4.tcp_syncookies = 1.', null],
        '3.3.9' => ['Đặt net.ipv6.conf.all.accept_ra = 0 nếu không dùng SLAAC.', null],
        '4.1.1' => ['Áp dụng tường lửa của panel (policy drop).', '/admin/servers/%s/firewall'],
        '5.1.4' => ['Giới hạn người dùng SSH (AllowGroups) trong cấu hình SSH của panel.', '/admin/security/ssh'],
        '5.1.7' => ['Đặt ClientAliveInterval ≤ 300 trong cấu hình SSH của panel.', '/admin/security/ssh'],
        '5.1.12' => ['Đặt MaxAuthTries ≤ 4 trong cấu hình SSH của panel.', '/admin/security/ssh'],
        '5.1.20' => ['Đặt PermitRootLogin no trong cấu hình SSH của panel.', '/admin/security/ssh'],
        '5.1.21' => ['Tắt đăng nhập SSH bằng mật khẩu trong cấu hình SSH của panel.', '/admin/security/ssh'],
        '5.3.3.2.1' => ['Đặt minlen = 14 trong /etc/security/pwquality.conf.', null],
        '5.4.2.1' => ['Xóa hoặc đổi UID các tài khoản có UID 0 ngoài root.', null],
        '5.4.2.4' => ['Khóa tài khoản có mật khẩu rỗng (passwd -l).', null],
        '6.1.1' => ['Cài auditd (Phần mềm › auditd) và bật quy tắc tối thiểu.', '/admin/servers/%s/software'],
        '6.2.1.1' => ['Đặt Storage=persistent trong /etc/systemd/journald.conf.', null],
        '6.2.2.1' => ['Sửa quyền file trong /var/log (không cho other ghi/đọc log nhạy cảm).', null],
        '7.1.1' => ['chmod 644 /etc/passwd; chown root:root /etc/passwd.', null],
        '7.1.5' => ['chmod 640 /etc/shadow; chown root:shadow /etc/shadow.', null],
        '7.1.11' => ['Bỏ quyền ghi cho other ở các file được liệt kê (chmod o-w).', null],
        '8.1.1' => ['Bật unattended-upgrades cho kênh security.', '/admin/servers/%s/software'],
        '8.1.2' => ['Cài bản vá bảo mật trong cửa sổ bảo trì (Phần mềm › cập nhật hệ điều hành).', '/admin/servers/%s/software'],
    ];

    public function __construct(private readonly JobDispatcher $jobs, private readonly AuditLogger $audit) {}

    public function audit(User $actor, Server $server, ?string $idempotencyKey = null): Job
    {
        return DB::transaction(function () use ($actor, $server, $idempotencyKey): Job {
            Server::query()->whereKey($server->id)->lockForUpdate()->first();
            $busy = Job::query()->where('type', 'cis.audit')->where('server_id', $server->id)
                ->whereIn('state', ['queued', 'running', 'cancel_requested', 'waiting_agent'])->exists();
            if ($busy) {
                throw ApiProblem::conflict("Đang kiểm CIS trên {$server->name}.");
            }
            $job = $this->jobs->dispatch((new JobSpec('cis.audit', $server, $server->id, 1, 300))
                ->step('cis.audit', ['profile' => self::PROFILE]), $actor, $idempotencyKey);
            $this->audit->record('security.cis_audit', $server, ['profile' => self::PROFILE], 'success', $server->id, $job->id, $actor);

            return $job;
        });
    }

    /** Job cis.audit xong: lưu kết quả, chỉ giữ KEEP lượt mới nhất của server. */
    public function store(Job $job): ?CisResult
    {
        $st = JobStep::query()->where('job_id', $job->id)->where('op', 'cis.audit')->where('state', 'succeeded')->first();
        if (! $st instanceof JobStep || ! is_array($st->result) || $job->server_id === null) {
            return null;
        }
        $items = [];
        foreach ((array) ($st->result['items'] ?? []) as $i) {
            if (! is_array($i) || ! in_array($i['status'] ?? null, ['pass', 'fail', 'na'], true)) {
                continue;
            }
            $items[] = ['id' => (string) $i['id'], 'group' => (string) $i['group'], 'title' => mb_substr((string) $i['title'], 0, 200),
                'status' => (string) $i['status'], 'evidence' => mb_substr((string) $i['evidence'], 0, 500)];
        }
        $count = fn (string $s): int => count(array_filter($items, fn (array $i): bool => $i['status'] === $s));
        [$pass, $fail] = [$count('pass'), $count('fail')];
        $r = CisResult::query()->create(['server_id' => $job->server_id, 'profile' => (string) ($st->result['profile'] ?? self::PROFILE),
            'score' => $pass + $fail === 0 ? 0 : (int) round(100 * $pass / ($pass + $fail)), 'passed' => $pass, 'failed' => $fail,
            'not_applicable' => $count('na'), 'items' => $items, 'job_id' => $job->id, 'audited_at' => Carbon::now()]);
        $old = CisResult::query()->where('server_id', $job->server_id)->orderByDesc('audited_at')->orderByDesc('id')->skip(self::KEEP)->take(1000)->pluck('id');
        CisResult::query()->whereIn('id', $old)->delete();

        return $r;
    }

    public static function latest(int $serverId): ?CisResult
    {
        return CisResult::query()->where('server_id', $serverId)->orderByDesc('audited_at')->orderByDesc('id')->first();
    }

    /** @return array<string, mixed> CisReport */
    public function report(Server $s): array
    {
        $r = self::latest($s->id);
        $items = array_map(function (array $i) use ($s): array {
            [$fix, $href] = self::REMEDIATION[$i['id']] ?? [null, null];
            $href = $href !== null ? sprintf($href, $s->uuid) : null;

            return $i + ['remediation' => $i['status'] === 'fail' ? $fix : null, 'fix_href' => $href];
        }, $r instanceof CisResult ? $r->items : []);

        return ['server' => ['uuid' => $s->uuid, 'name' => $s->name], 'profile' => $r instanceof CisResult ? $r->profile : self::PROFILE,
            'audited_at' => $r?->audited_at->toIso8601String(), 'score' => $r instanceof CisResult ? $r->score : 0,
            'passed' => $r instanceof CisResult ? $r->passed : 0, 'failed' => $r instanceof CisResult ? $r->failed : 0,
            'not_applicable' => $r instanceof CisResult ? $r->not_applicable : 0, 'items' => $items];
    }
}
