<?php

declare(strict_types=1);

namespace App\Domain\Backup;

use App\Domain\Setup\Settings;
use App\Models\Setting;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;

/**
 * Cặp khóa age X25519 của panel (ADR 0031 §4): backup panel được agent mã hóa tới khóa công khai; khóa riêng chỉ
 * dùng cho bộ khôi phục (SA lưu offline) — lưu mã hóa Crypt trong settings để hiện lại bộ khôi phục (SUPER_ADMIN +
 * step-up), không bao giờ vào params job hay gửi agent. Sinh bằng libsodium (không gọi lệnh ngoài), mã hóa bech32.
 */
final class AgeKeys
{
    private const GROUP = 'backup';

    /** @return array{public: string, private: string} khóa của panel, sinh lần đầu khi cần. */
    public static function panel(): array
    {
        return DB::transaction(function (): array {
            $pub = Setting::query()->where('group_key', self::GROUP)->where('key', 'panel_public_key')->lockForUpdate()->first();
            $priv = Setting::query()->where('group_key', self::GROUP)->where('key', 'panel_private_key')->first();
            if ($pub !== null && $priv !== null && is_string($pub->value['v'] ?? null) && is_string($priv->value['v'] ?? null)) {
                return ['public' => $pub->value['v'], 'private' => Crypt::decryptString($priv->value['v'])];
            }
            $k = self::generate();
            Setting::query()->updateOrCreate(['group_key' => self::GROUP, 'key' => 'panel_public_key'], ['value' => ['v' => $k['public']], 'is_encrypted' => false]);
            Setting::query()->updateOrCreate(['group_key' => self::GROUP, 'key' => 'panel_private_key'],
                ['value' => ['v' => Crypt::encryptString($k['private'])], 'is_encrypted' => true]);

            return $k;
        });
    }

    public static function publicKey(): string
    {
        $v = Settings::get(self::GROUP, 'panel_public_key');

        return is_string($v) && $v !== '' ? $v : self::panel()['public'];
    }

    /** @return array{public: string, private: string} */
    public static function generate(): array
    {
        $secret = random_bytes(SODIUM_CRYPTO_SCALARMULT_SCALARBYTES);
        $public = sodium_crypto_scalarmult_base($secret);

        return ['public' => self::bech32('age', $public), 'private' => strtoupper(self::bech32('age-secret-key-', $secret))];
    }

    /** Khóa công khai từ khóa riêng AGE-SECRET-KEY-1… (kiểm bộ khôi phục). */
    public static function publicFromPrivate(string $identity): ?string
    {
        $raw = self::bech32Decode(strtolower(trim($identity)), 'age-secret-key-');

        return $raw === null || strlen($raw) !== 32 ? null : self::bech32('age', sodium_crypto_scalarmult_base($raw));
    }

    private const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

    public static function bech32(string $hrp, string $data): string
    {
        $values = self::convertBits(array_values(unpack('C*', $data) ?: []), 8, 5, true);
        $chk = self::checksum($hrp, $values);
        $out = $hrp.'1';
        foreach (array_merge($values, $chk) as $v) {
            $out .= self::CHARSET[$v];
        }

        return $out;
    }

    public static function bech32Decode(string $s, string $hrp): ?string
    {
        if (! str_starts_with($s, $hrp.'1')) {
            return null;
        }
        $vals = [];
        foreach (str_split(substr($s, strlen($hrp) + 1)) as $c) {
            $i = strpos(self::CHARSET, $c);
            if ($i === false) {
                return null;
            }
            $vals[] = $i;
        }
        if (count($vals) < 6 || self::polymod(array_merge(self::hrpExpand($hrp), $vals)) !== 1) {
            return null;
        }
        $bytes = self::convertBits(array_slice($vals, 0, -6), 5, 8, false);

        return $bytes === [] ? null : pack('C*', ...$bytes);
    }

    /**
     * @param  list<int>  $data
     * @return list<int>
     */
    private static function convertBits(array $data, int $from, int $to, bool $pad): array
    {
        $acc = 0;
        $bits = 0;
        $out = [];
        $max = (1 << $to) - 1;
        foreach ($data as $v) {
            $acc = ($acc << $from) | $v;
            $bits += $from;
            while ($bits >= $to) {
                $bits -= $to;
                $out[] = ($acc >> $bits) & $max;
            }
        }
        if ($pad && $bits > 0) {
            $out[] = ($acc << ($to - $bits)) & $max;
        }

        return $out;
    }

    /** @return list<int> */
    private static function hrpExpand(string $hrp): array
    {
        $a = [];
        $b = [];
        foreach (str_split($hrp) as $c) {
            $a[] = ord($c) >> 5;
            $b[] = ord($c) & 31;
        }

        return array_merge($a, [0], $b);
    }

    /** @param list<int> $values */
    private static function polymod(array $values): int
    {
        $gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3];
        $chk = 1;
        foreach ($values as $v) {
            $top = $chk >> 25;
            $chk = (($chk & 0x1FFFFFF) << 5) ^ $v;
            for ($i = 0; $i < 5; $i++) {
                if ((($top >> $i) & 1) === 1) {
                    $chk ^= $gen[$i];
                }
            }
        }

        return $chk;
    }

    /**
     * @param  list<int>  $values
     * @return list<int>
     */
    private static function checksum(string $hrp, array $values): array
    {
        $pm = self::polymod(array_merge(self::hrpExpand($hrp), $values, [0, 0, 0, 0, 0, 0])) ^ 1;
        $out = [];
        for ($i = 0; $i < 6; $i++) {
            $out[] = ($pm >> (5 * (5 - $i))) & 31;
        }

        return $out;
    }
}
