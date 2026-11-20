<?php

declare(strict_types=1);

namespace App\Casts;

use Illuminate\Contracts\Database\Eloquent\CastsAttributes;
use Illuminate\Database\Eloquent\Model;

/**
 * Cột PostgreSQL `text[]` ↔ mảng chuỗi PHP. Chỉ nhận phần tử không chứa `{ } , "` hay khoảng
 * trắng (giá trị trong panel: phiên bản PHP, tag vai trò server) — không phải parser mảng đầy đủ.
 *
 * @implements CastsAttributes<list<string>, list<string>>
 */
final class PgTextArray implements CastsAttributes
{
    public function get(Model $model, string $key, mixed $value, array $attributes): array
    {
        if ($value === null || $value === '{}' || $value === '') {
            return [];
        }

        return array_map(
            static fn (string $v): string => trim($v, '"'),
            explode(',', trim((string) $value, '{}')),
        );
    }

    public function set(Model $model, string $key, mixed $value, array $attributes): string
    {
        $items = array_map('strval', (array) $value);
        foreach ($items as $v) {
            if ($v === '' || preg_match('/[{},"\s\\\\]/', $v)) {
                throw new \InvalidArgumentException("Giá trị không hợp lệ cho {$key}: ".json_encode($v));
            }
        }

        return '{'.implode(',', $items).'}';
    }
}
