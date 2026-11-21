<?php

declare(strict_types=1);

namespace App\Domain\Security;

/**
 * IP/CIDR chặt như net/netip của agent: octet > 255, prefix sai, bit host → từ chối (không tự chuẩn hóa).
 */
final class Net
{
    /** @return array{0: string, 1: int}|null [địa chỉ nhị phân, prefix] */
    public static function cidr(string $s): ?array
    {
        $parts = explode('/', $s, 2);
        $addr = $parts[0];
        $bits = $parts[1] ?? null;
        $bin = self::ip($addr);
        if ($bin === null) {
            return null;
        }
        $max = strlen($bin) * 8;
        if ($bits === null) {
            return [$bin, $max];
        }
        if (preg_match('/^(0|[1-9][0-9]{0,2})$/', $bits) !== 1 || (int) $bits > $max) {
            return null;
        }
        $p = (int) $bits;

        return self::mask($bin, $p) === $bin ? [$bin, $p] : null;
    }

    /** Địa chỉ IPv4/IPv6 → nhị phân (IPv4-mapped IPv6 → IPv4); không nhận zone, số 0 đứng đầu ở IPv4. */
    public static function ip(string $s): ?string
    {
        if ($s === '' || str_contains($s, '%') || preg_match('/(^|\.)0[0-9]/', $s) === 1) {
            return null;
        }
        $bin = @inet_pton($s);
        if ($bin === false) {
            return null;
        }
        if (strlen($bin) === 16 && str_starts_with($bin, str_repeat("\0", 10)."\xff\xff")) {
            return substr($bin, 12);
        }

        return $bin;
    }

    public static function contains(string $cidr, string $ip): bool
    {
        $c = self::cidr($cidr);
        $a = self::ip($ip);
        if ($c === null || $a === null || strlen($c[0]) !== strlen($a)) {
            return false;
        }

        return self::mask($a, $c[1]) === $c[0];
    }

    public static function isAny(string $cidr): bool
    {
        $c = self::cidr($cidr);

        return $c !== null && $c[1] === 0;
    }

    public static function isV6(string $cidr): bool
    {
        $c = self::cidr($cidr);

        return $c !== null && strlen($c[0]) === 16;
    }

    /** Dạng chuẩn để hiển thị/so sánh (IPv6 rút gọn, IPv4-mapped → IPv4). */
    public static function normalize(string $cidr): string
    {
        $c = self::cidr($cidr);
        if ($c === null) {
            return $cidr;
        }
        $addr = (string) inet_ntop($c[0]);

        return str_contains($cidr, '/') ? $addr.'/'.$c[1] : $addr;
    }

    private static function mask(string $bin, int $prefix): string
    {
        $out = '';
        for ($i = 0, $n = strlen($bin); $i < $n; $i++) {
            $bits = max(0, min(8, $prefix - $i * 8));
            $out .= chr(ord($bin[$i]) & ((0xFF << (8 - $bits)) & 0xFF));
        }

        return $out;
    }
}
