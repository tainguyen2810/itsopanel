<?php

declare(strict_types=1);

namespace App\Http\Support;

use App\Exceptions\ApiProblem;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Request;

/**
 * Phân trang theo vị trí cho danh sách không có khóa ổn định để làm cursor (kết quả uptime, bảng tính trong bộ nhớ).
 * Cursor là base64("o:<vị trí>"), `limit` 1–200 (mặc định 50) như Listing.
 */
final class OffsetPage
{
    /** @return array{0: int, 1: int} [offset, limit] */
    public static function params(Request $request): array
    {
        $limit = $request->query('limit', '50');
        if (! is_string($limit) || ! ctype_digit($limit) || (int) $limit < 1 || (int) $limit > 200) {
            throw ApiProblem::field('limit', 'limit phải là số nguyên 1–200.');
        }
        $cursor = $request->query('cursor');
        $offset = 0;
        if (is_string($cursor) && $cursor !== '') {
            $raw = base64_decode($cursor, true);
            if ($raw === false || preg_match('/^o:(\d{1,7})$/', $raw, $m) !== 1) {
                throw ApiProblem::field('cursor', 'cursor không hợp lệ.');
            }
            $offset = (int) $m[1];
        }

        return [$offset, (int) $limit];
    }

    /**
     * @param  callable(\stdClass): array<string, mixed>  $present
     * @return array{data: list<array<string, mixed>>, meta: array{next_cursor: string|null, limit: int}}
     */
    public static function of(Request $request, Builder $query, callable $present): array
    {
        [$offset, $limit] = self::params($request);
        $rows = $query->offset($offset)->limit($limit + 1)->get()->all();
        $more = count($rows) > $limit;
        $data = array_map($present, array_slice($rows, 0, $limit));

        return ['data' => $data, 'meta' => ['next_cursor' => $more ? base64_encode('o:'.($offset + $limit)) : null, 'limit' => $limit]];
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     * @return array{data: list<array<string, mixed>>, meta: array{next_cursor: string|null, limit: int}}
     */
    public static function ofArray(Request $request, array $rows): array
    {
        [$offset, $limit] = self::params($request);

        return ['data' => array_slice($rows, $offset, $limit),
            'meta' => ['next_cursor' => $offset + $limit < count($rows) ? base64_encode('o:'.($offset + $limit)) : null, 'limit' => $limit]];
    }
}
