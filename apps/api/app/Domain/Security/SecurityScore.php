<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Models\MfaCredential;
use App\Models\Server;
use App\Models\User;
use App\Models\WafSetting;
use App\Models\Website;
use Illuminate\Support\Facades\DB;

/**
 * Điểm bảo mật (ADR 0027 §3): bảng trọng số công khai, tổng 100. `warn` được nửa điểm. Dữ kiện máy chủ lấy từ
 * security.audit gần nhất; MFA, WAF, IP allowlist lấy từ panel.
 */
final class SecurityScore
{
    /** @var array<string, array{0: int, 1: string, 2: string}> khóa → [trọng số, tiêu đề, mức độ nếu trượt] */
    public const WEIGHTS = [
        'ssh_password_disabled' => [15, 'SSH tắt đăng nhập mật khẩu', 'high'],
        'ssh_root_login' => [10, 'SSH không cho root đăng nhập bằng mật khẩu', 'high'],
        'firewall_policy_drop' => [15, 'Tường lửa mặc định chặn (policy drop)', 'critical'],
        'fail2ban_running' => [10, 'Fail2ban đang chạy', 'medium'],
        'admin_mfa' => [15, 'Mọi quản trị viên bật MFA', 'critical'],
        'waf_coverage' => [10, 'WAF bật cho website', 'medium'],
        'security_updates' => [10, 'Đã cài bản vá bảo mật', 'high'],
        'fim_clean' => [5, 'Toàn vẹn file hệ thống (FIM) không đổi', 'medium'],
        'admin_ip_allowlist' => [10, 'IP allowlist cho Admin Panel', 'low'],
    ];

    /**
     * @param  array<string, mixed>|null  $facts  kết quả security.audit
     * @return array{score: int, grade: string, items: list<array{key: string, title: string, weight: int, earned: int, status: string, detail: string}>}
     */
    public function compute(Server $server, ?array $facts): array
    {
        $f = $facts ?? [];
        $sshd = (array) ($f['sshd'] ?? []);
        $fw = (array) ($f['firewall'] ?? []);
        $f2b = (array) ($f['fail2ban'] ?? []);
        $upd = (array) ($f['updates'] ?? []);
        $fim = (array) ($f['fim'] ?? []);
        $unknown = ['warn', 'Chưa có dữ kiện từ agent (security.audit).'];

        $status = [];
        $status['ssh_password_disabled'] = $sshd === [] ? $unknown : (($sshd['password_authentication'] ?? true) === false
            ? ['pass', 'PasswordAuthentication no'] : ['fail', 'Đang cho phép đăng nhập SSH bằng mật khẩu.']);
        $root = (string) ($sshd['permit_root_login'] ?? '');
        $status['ssh_root_login'] = $sshd === [] ? $unknown : match ($root) {
            'no' => ['pass', 'PermitRootLogin no'],
            'prohibit-password', 'without-password' => ['pass', 'PermitRootLogin prohibit-password'],
            default => ['fail', "PermitRootLogin $root"],
        };
        $status['firewall_policy_drop'] = $fw === [] ? $unknown : (($fw['table_present'] ?? false) && ($fw['input_policy'] ?? '') === 'drop'
            ? ['pass', 'Bảng inet itso, policy drop, '.(int) ($fw['rules'] ?? 0).' rule.'] : ['fail', 'Chưa áp dụng tường lửa của panel.']);
        $status['fail2ban_running'] = $f2b === [] ? $unknown : (($f2b['running'] ?? false)
            ? ['pass', (int) ($f2b['jails'] ?? 0).' jail đang chạy.'] : ['fail', 'Fail2ban không chạy.']);
        $status['admin_mfa'] = $this->mfa();
        $status['waf_coverage'] = $this->waf($server);
        $pending = (int) ($upd['pending_security'] ?? 0);
        $status['security_updates'] = $upd === [] ? $unknown : match (true) {
            $pending === 0 && ! ($upd['reboot_required'] ?? false) => ['pass', 'Không còn bản vá bảo mật chờ cài.'],
            $pending === 0 => ['warn', 'Cần khởi động lại để áp dụng bản vá.'],
            ($upd['unattended_upgrades'] ?? false) && $pending <= 5 => ['warn', "$pending gói bảo mật chờ (unattended-upgrades đang bật)."],
            default => ['fail', "$pending gói bảo mật chờ cài."],
        };
        $status['fim_clean'] = $fim === [] ? $unknown : match (true) {
            ! ($fim['baseline_present'] ?? false) => ['warn', 'Chưa có baseline FIM.'],
            (int) ($fim['changes'] ?? 0) === 0 => ['pass', 'Không có thay đổi so với baseline.'],
            default => ['fail', (int) $fim['changes'].' file hệ thống thay đổi so với baseline.'],
        };
        $allow = DB::table('ip_allowlist')->where('scope', 'admin')->count();
        $status['admin_ip_allowlist'] = $allow > 0 ? ['pass', "$allow dải IP được phép."] : ['warn', 'Chưa giới hạn IP vào Admin Panel.'];

        $items = [];
        $score = 0;
        foreach (self::WEIGHTS as $key => [$w, $title]) {
            [$st, $detail] = $status[$key];
            $earned = match ($st) {
                'pass' => $w,
                'warn' => intdiv($w, 2),
                default => 0,
            };
            $score += $earned;
            $items[] = ['key' => $key, 'title' => $title, 'weight' => $w, 'earned' => $earned, 'status' => $st, 'detail' => $detail];
        }

        return ['score' => $score, 'grade' => self::grade($score), 'items' => $items];
    }

    public static function grade(int $score): string
    {
        return match (true) {
            $score >= 90 => 'A',
            $score >= 80 => 'B',
            $score >= 70 => 'C',
            $score >= 60 => 'D',
            default => 'F',
        };
    }

    /** @return array{0: string, 1: string} */
    private function mfa(): array
    {
        $admins = User::query()->where('realm', 'admin')->where('status', 'active')->pluck('id');
        $with = MfaCredential::query()->whereIn('user_id', $admins)->where('type', 'totp')
            ->distinct()->count('user_id');
        $n = $admins->count();

        return $n > 0 && $with >= $n ? ['pass', "$n/$n quản trị viên đã bật MFA."] : ['fail', "$with/$n quản trị viên đã bật MFA."];
    }

    /** @return array{0: string, 1: string} */
    private function waf(Server $server): array
    {
        $sites = Website::query()->where('server_id', $server->id)->pluck('id');
        if ($sites->isEmpty()) {
            return ['pass', 'Chưa có website.'];
        }
        $on = WafSetting::query()->whereIn('website_id', $sites)->where('available', true)->whereIn('mode', ['DetectionOnly', 'On'])->count();
        $n = $sites->count();

        return match (true) {
            $on >= $n => ['pass', "$on/$n website bật WAF."],
            $on > 0 => ['warn', "$on/$n website bật WAF."],
            default => ['fail', "0/$n website bật WAF."],
        };
    }
}
