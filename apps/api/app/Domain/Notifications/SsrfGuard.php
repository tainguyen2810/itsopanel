<?php

declare(strict_types=1);

namespace App\Domain\Notifications;

/**
 * Chặn SSRF cho webhook (ADR 0048 §3): phân giải DNS trước, trả IP đã kiểm để kết nối đúng IP đó (chống DNS rebinding).
 * Luôn chặn loopback, link-local (gồm metadata 169.254.169.254), 0.0.0.0/8, multicast, broadcast, dải dành riêng;
 * dải riêng (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) chỉ khi kênh bật allow_private_network.
 */
class SsrfGuard
{
    /** @var \Closure(string): list<string> */
    private \Closure $resolver;

    /** @param  (\Closure(string): list<string>)|null  $resolver  host → danh sách IP (test thay bằng bản giả) */
    public function __construct(?\Closure $resolver = null)
    {
        $this->resolver = $resolver ?? static function (string $host): array {
            $ips = [];
            foreach ([DNS_A, DNS_AAAA] as $t) {
                $recs = @dns_get_record($host, $t);
                foreach (is_array($recs) ? $recs : [] as $r) {
                    $ip = $r['ip'] ?? $r['ipv6'] ?? null;
                    if (is_string($ip)) {
                        $ips[] = $ip;
                    }
                }
            }

            return $ips;
        };
    }

    /**
     * @return array{scheme: string, host: string, port: int, ip: string}
     *
     * @throws BlockedDestination
     */
    public function check(string $url, bool $allowPrivate): array
    {
        $p = parse_url($url);
        $scheme = strtolower((string) ($p['scheme'] ?? ''));
        $host = strtolower(trim((string) ($p['host'] ?? ''), '[]'));
        if (! in_array($scheme, ['http', 'https'], true) || $host === '' || isset($p['user']) || isset($p['pass'])) {
            throw new BlockedDestination('URL webhook không hợp lệ.');
        }
        if ($scheme === 'http' && ! $allowPrivate) {
            throw new BlockedDestination('Chỉ dùng https://; http:// chỉ khi bật "Cho phép mạng riêng".');
        }
        $port = (int) ($p['port'] ?? ($scheme === 'https' ? 443 : 80));
        $ips = filter_var($host, FILTER_VALIDATE_IP) !== false ? [$host] : ($this->resolver)($host);
        if ($ips === []) {
            throw new BlockedDestination("Không phân giải được tên miền $host.");
        }
        foreach ($ips as $ip) {
            $why = self::classify($ip);
            if ($why === 'always') {
                throw new BlockedDestination("Địa chỉ $ip (loopback/link-local/metadata/dành riêng) luôn bị chặn.");
            }
            if ($why === 'private' && ! $allowPrivate) {
                throw new BlockedDestination("Địa chỉ $ip thuộc mạng riêng; bật \"Cho phép mạng riêng\" nếu cố ý.");
            }
        }

        return ['scheme' => $scheme, 'host' => $host, 'port' => $port, 'ip' => $ips[0]];
    }

    /** @return 'always'|'private'|null */
    public static function classify(string $ip): ?string
    {
        $bin = @inet_pton($ip);
        if ($bin === false) {
            return 'always';
        }
        if (strlen($bin) === 16) {
            // IPv4-mapped (::ffff:a.b.c.d) → kiểm như IPv4; IPv4-compatible (::/96, gồm :: và ::1) luôn chặn.
            if (str_starts_with($bin, str_repeat("\0", 10)."\xff\xff")) {
                return self::classify((string) inet_ntop(substr($bin, 12)));
            }
            foreach (['::/96', 'fe80::/10', 'ff00::/8', '64:ff9b::/96', '2001:db8::/32', 'fec0::/10', '100::/64'] as $c) {
                if (self::inCidr($bin, $c)) {
                    return 'always';
                }
            }

            return self::inCidr($bin, 'fc00::/7') ? 'private' : null;
        }
        foreach (['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4', '192.0.0.0/24', '192.0.2.0/24',
            '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24'] as $c) {
            if (self::inCidr($bin, $c)) {
                return 'always';
            }
        }
        foreach (['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'] as $c) {
            if (self::inCidr($bin, $c)) {
                return 'private';
            }
        }

        return null;
    }

    private static function inCidr(string $bin, string $cidr): bool
    {
        [$net, $bits] = explode('/', $cidr);
        $n = (string) inet_pton($net);
        if (strlen($n) !== strlen($bin)) {
            return false;
        }
        $bits = (int) $bits;
        $bytes = intdiv($bits, 8);
        if (substr($bin, 0, $bytes) !== substr($n, 0, $bytes)) {
            return false;
        }
        $rem = $bits % 8;
        if ($rem === 0) {
            return true;
        }
        $mask = (0xFF << (8 - $rem)) & 0xFF;

        return (ord($bin[$bytes]) & $mask) === (ord($n[$bytes]) & $mask);
    }
}
