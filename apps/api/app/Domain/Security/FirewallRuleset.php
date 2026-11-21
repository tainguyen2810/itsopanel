<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Exceptions\ApiProblem;
use App\Models\FirewallRule;

/**
 * Bản PHP của ops.NormalizeFirewall/RenderNft (agent/internal/ops/firewall.go, ADR 0023): kiểm rule + bất biến
 * chống tự khóa ở Laravel (lớp thứ nhất; agent kiểm lại) và sinh ruleset để xem trước. Test so với golden của agent
 * (`agent/internal/ops/testdata/golden/firewall.nft`) để hai bản không lệch nhau.
 */
final class FirewallRuleset
{
    public const TABLE = 'itso';

    private const COMMENT = '/^[^\x00-\x1f\x7f"\\\\]*$/u';

    /**
     * Rule dạng params agent (FirewallRule của agent-ops) từ các rule đang bật, theo priority.
     *
     * @param  iterable<FirewallRule>  $rules
     * @return list<array{priority: int, action: string, direction: string, protocol: string, ports: string|null, source: string, comment: string}>
     */
    public static function params(iterable $rules): array
    {
        $out = [];
        foreach ($rules as $r) {
            if (! $r->enabled) {
                continue;
            }
            $out[] = ['priority' => $r->priority, 'action' => $r->action, 'direction' => $r->direction,
                'protocol' => $r->protocol, 'ports' => $r->port_range, 'source' => (string) ($r->source_cidr ?? '0.0.0.0/0'),
                'comment' => (string) ($r->comment ?? '')];
        }
        usort($out, fn (array $a, array $b): int => $a['priority'] <=> $b['priority']);

        return $out;
    }

    /**
     * Kiểm một rule (đã qua validate schema). Trả thông báo lỗi hoặc null.
     *
     * @param  array<string, mixed>  $r
     */
    public static function invalid(array $r): ?string
    {
        $prio = $r['priority'] ?? null;
        if (! is_int($prio) || $prio < 1 || $prio > 9999) {
            return 'priority ngoài 1–9999';
        }
        if (! in_array($r['action'] ?? null, ['accept', 'drop', 'reject'], true)) {
            return 'action không hợp lệ';
        }
        if (! in_array($r['direction'] ?? null, ['in', 'out'], true)) {
            return 'direction không hợp lệ';
        }
        if (! in_array($r['protocol'] ?? null, ['tcp', 'udp', 'icmp', 'any'], true)) {
            return 'protocol không hợp lệ';
        }
        $comment = $r['comment'] ?? '';
        if (! is_string($comment) || mb_strlen($comment) > 200 || preg_match(self::COMMENT, $comment) !== 1) {
            return 'comment chứa ký tự cấm';
        }
        $ports = $r['ports'] ?? null;
        if ($ports !== null) {
            if ($r['protocol'] === 'icmp') {
                return 'icmp không có cổng';
            }
            if (! is_string($ports) || self::ports($ports) === null) {
                return 'ports ngoài 1–65535 hoặc sai định dạng';
            }
        }
        if (! is_string($r['source'] ?? null) || Net::cidr($r['source']) === null) {
            return 'source không phải IP/CIDR hợp lệ (octet ≤ 255, không có bit host)';
        }

        return null;
    }

    /** @return list<array{0: int, 1: int}>|null */
    public static function ports(string $s): ?array
    {
        if ($s === '' || preg_match('/^[0-9]{1,5}(-[0-9]{1,5})?(,[0-9]{1,5}(-[0-9]{1,5})?)*$/', $s) !== 1) {
            return null;
        }
        $parts = explode(',', $s);
        if (count($parts) > 50) {
            return null;
        }
        $out = [];
        foreach ($parts as $p) {
            [$lo, $hi] = array_pad(explode('-', $p, 2), 2, null);
            $a = (int) $lo;
            $b = $hi === null ? $a : (int) $hi;
            if ($a < 1 || $b > 65535 || $a > $b) {
                return null;
            }
            $out[] = [$a, $b];
        }

        return $out;
    }

    /**
     * Bất biến chống tự khóa (D-76): rule vào drop/reject phủ cổng SSH hoặc panel với nguồn chứa IP người áp dụng.
     *
     * @param  array<string, mixed>  $r
     */
    public static function locksOut(array $r, int $sshPort, int $panelPort, string $clientIp): bool
    {
        if (($r['direction'] ?? '') !== 'in' || ($r['action'] ?? '') === 'accept') {
            return false;
        }
        $src = (string) ($r['source'] ?? '');

        return (Net::isAny($src) || Net::contains($src, $clientIp))
            && (self::covers($r, $sshPort) || self::covers($r, $panelPort));
    }

    /**
     * Kiểm toàn bộ danh sách; lỗi → ApiProblem 422 (`would_lock_out` hoặc `validation_failed`).
     *
     * @param  list<array<string, mixed>>  $rules
     */
    public static function check(array $rules, int $sshPort, int $panelPort, string $clientIp): void
    {
        if (count($rules) > 500) {
            throw ApiProblem::field('rules', 'Tối đa 500 rule.');
        }
        foreach ($rules as $i => $r) {
            $err = self::invalid($r);
            if ($err !== null) {
                throw ApiProblem::field('rules', "Rule $i: $err.");
            }
            if (self::locksOut($r, $sshPort, $panelPort, $clientIp)) {
                throw self::lockout("Rule ưu tiên {$r['priority']} chặn cổng SSH $sshPort/panel $panelPort từ IP đang dùng $clientIp.");
            }
        }
    }

    public static function lockout(string $detail): ApiProblem
    {
        return new ApiProblem(422, 'would_lock_out', 'Thao tác sẽ khóa chính bạn', $detail);
    }

    /**
     * Ruleset nft giống hệt RenderNft của agent (rule đã kiểm, sắp theo priority).
     *
     * @param  list<array<string, mixed>>  $rules
     */
    public static function render(array $rules, int $sshPort, int $panelPort, string $clientIp): string
    {
        $in = $out = '';
        foreach ($rules as $r) {
            if ($r['direction'] === 'in') {
                $in .= self::renderRule($r);
            } else {
                $out .= self::renderRule($r);
            }
        }
        $client = (string) inet_ntop((string) Net::ip($clientIp));
        $fam = str_contains($client, ':') ? 'ip6' : 'ip';
        $t = self::TABLE;
        $b = "# Sinh bởi itso-agent (firewall.apply). Không sửa tay.\n";
        $b .= "table inet $t\ndelete table inet $t\n";
        $b .= "table inet $t {\n  chain input {\n    type filter hook input priority filter; policy drop;\n";
        $b .= "    iif \"lo\" accept\n    ct state established,related accept\n    ct state invalid drop\n";
        $b .= "    meta l4proto icmp icmp type { echo-request, destination-unreachable, time-exceeded } limit rate 10/second accept\n";
        $b .= "    meta l4proto ipv6-icmp accept\n";
        $guard = $sshPort === $panelPort ? (string) $sshPort : "{ $sshPort, $panelPort }";
        $b .= "    $fam saddr $client tcp dport $guard accept comment \"itso: chống tự khóa\"\n";
        foreach ([[$sshPort, 'ssh'], [$panelPort, 'panel']] as [$port, $name]) {
            $mentioned = false;
            foreach ($rules as $r) {
                if ($r['direction'] === 'in' && ($r['ports'] ?? null) !== null && self::covers($r, $port)) {
                    $mentioned = true;
                }
            }
            if (! $mentioned && ($name === 'ssh' || $panelPort !== $sshPort)) {
                $b .= "    tcp dport $port accept comment \"itso: $name\"\n";
            }
        }
        $b .= $in."  }\n  chain output {\n    type filter hook output priority filter; policy accept;\n".$out."  }\n}\n";

        return $b;
    }

    /** @param  array<string, mixed>  $r */
    private static function covers(array $r, int $port): bool
    {
        if (($r['protocol'] ?? '') === 'icmp') {
            return false;
        }
        $ports = $r['ports'] ?? null;
        if ($ports === null) {
            return true;
        }
        foreach (self::ports((string) $ports) ?? [] as [$lo, $hi]) {
            if ($lo <= $port && $port <= $hi) {
                return true;
            }
        }

        return false;
    }

    /** @param  array<string, mixed>  $r */
    private static function renderRule(array $r): string
    {
        $b = '    ';
        $src = (string) $r['source'];
        if (! Net::isAny($src)) {
            $fam = Net::isV6($src) ? 'ip6' : 'ip';
            $b .= $fam.($r['direction'] === 'in' ? ' saddr ' : ' daddr ').self::prefix($src).' ';
        }
        $ports = '';
        if (($r['ports'] ?? null) !== null) {
            $ps = array_map(fn (array $p): string => $p[0] === $p[1] ? (string) $p[0] : "{$p[0]}-{$p[1]}", self::ports((string) $r['ports']) ?? []);
            $ports = count($ps) > 1 ? '{ '.implode(', ', $ps).' }' : ($ps[0] ?? '');
        }
        $proto = (string) $r['protocol'];
        $b .= match (true) {
            $proto === 'icmp' => 'meta l4proto { icmp, ipv6-icmp } ',
            $ports !== '' && $proto === 'any' => "meta l4proto { tcp, udp } th dport $ports ",
            $ports !== '' => "$proto dport $ports ",
            $proto !== 'any' => "meta l4proto $proto ",
            default => '',
        };
        $b .= (string) $r['action'];
        $comment = (string) ($r['comment'] ?? '');
        if ($comment !== '') {
            $b .= ' comment "'.$comment.'"';
        }

        return $b."\n";
    }

    /** Prefix như netip.Prefix.String(): luôn có /bits. */
    private static function prefix(string $cidr): string
    {
        $c = Net::cidr($cidr);

        return $c === null ? $cidr : inet_ntop($c[0]).'/'.$c[1];
    }
}
