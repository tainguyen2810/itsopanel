<?php

declare(strict_types=1);

namespace App\Casts;

use Illuminate\Contracts\Database\Eloquent\CastsAttributes;
use Illuminate\Database\Eloquent\Model;

/**
 * Cột bytea của PostgreSQL ↔ chuỗi nhị phân PHP (PDO trả stream; ghi bằng dạng hex `\x…`).
 *
 * @implements CastsAttributes<string|null, string|null>
 */
final class Bytea implements CastsAttributes
{
    public function get(Model $model, string $key, mixed $value, array $attributes): ?string
    {
        if ($value === null) {
            return null;
        }
        if (is_resource($value)) {
            $value = stream_get_contents($value);
            if ($value === false) {
                return null;
            }
        }
        $s = (string) $value;

        return str_starts_with($s, '\\x') ? (hex2bin(substr($s, 2)) ?: '') : $s;
    }

    public function set(Model $model, string $key, mixed $value, array $attributes): ?string
    {
        return $value === null ? null : '\\x'.bin2hex((string) $value);
    }
}
