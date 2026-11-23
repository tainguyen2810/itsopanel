<?php

declare(strict_types=1);

namespace App\Http\Support;

use App\Exceptions\ApiProblem;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Request;

/**
 * Danh sách theo quy ước API: `limit` (1–200, mặc định 50), `cursor`, `sort` (`-created_at,name`), `q`.
 * Cursor pagination của Laravel trên các cột sort + khóa chính (thứ tự ổn định).
 */
final class Listing
{
    /**
     * @template TModel of Model
     *
     * @param  Builder<TModel>  $query
     * @param  array<string, string>  $sortable  tên sort công khai → cột
     * @param  callable(TModel): array<string, mixed>  $present
     * @param  (callable(list<TModel>): mixed)|null  $prefetch  nạp trước dữ liệu liên quan của cả trang (chặn N+1); trả callable thì
     *                                                          gọi sau khi trình bày xong (xóa cache tĩnh)
     * @return array{data: list<array<string, mixed>>, meta: array{next_cursor: string|null, limit: int}}
     */
    public static function page(Request $request, Builder $query, array $sortable, string $defaultSort, callable $present, ?callable $prefetch = null): array
    {
        $limit = $request->query('limit', '50');
        if (! is_string($limit) || ! ctype_digit($limit) || (int) $limit < 1 || (int) $limit > 200) {
            throw ApiProblem::field('limit', 'limit phải là số nguyên 1–200.');
        }
        $sort = $request->query('sort', $defaultSort);
        if (! is_string($sort) || preg_match('/^-?[a-z_]+(,-?[a-z_]+)*$/', $sort) !== 1) {
            throw ApiProblem::field('sort', 'sort không hợp lệ.');
        }
        $table = $query->getModel()->getTable();
        foreach (explode(',', $sort) as $part) {
            $desc = str_starts_with($part, '-');
            $name = ltrim($part, '-');
            if (! isset($sortable[$name])) {
                throw ApiProblem::field('sort', "Không sắp xếp được theo $name.");
            }
            $query->orderBy($sortable[$name], $desc ? 'desc' : 'asc');
        }
        if (! in_array("$table.id", array_map(fn (string $p): string => $sortable[ltrim($p, '-')], explode(',', $sort)), true)) {
            $query->orderBy("$table.id", 'desc');
        }
        $cursor = $request->query('cursor');
        try {
            $page = $query->cursorPaginate((int) $limit, ["$table.*"], 'cursor', is_string($cursor) ? $cursor : null);
        } catch (\Throwable) {
            throw ApiProblem::field('cursor', 'cursor không hợp lệ.');
        }
        $data = [];
        $done = $prefetch !== null ? $prefetch(array_values($page->items())) : null;
        try {
            foreach ($page->items() as $item) {
                $data[] = $present($item);
            }
        } finally {
            if (is_callable($done)) {
                $done();
            }
        }

        return ['data' => $data, 'meta' => ['next_cursor' => $page->nextCursor()?->encode(), 'limit' => (int) $limit]];
    }

    /**
     * Điều kiện tìm kiếm tự do `q` (ILIKE trên các cột).
     *
     * @template TModel of Model
     *
     * @param  Builder<TModel>  $query
     * @param  list<string>  $columns
     */
    public static function search(Request $request, Builder $query, array $columns): void
    {
        $q = $request->query('q');
        if (! is_string($q) || trim($q) === '') {
            return;
        }
        if (mb_strlen($q) > 200) {
            throw ApiProblem::field('q', 'q tối đa 200 ký tự.');
        }
        $like = '%'.addcslashes(trim($q), '%_\\').'%';
        $query->where(function (Builder $w) use ($columns, $like): void {
            foreach ($columns as $c) {
                $w->orWhere($c, 'ILIKE', $like);
            }
        });
    }
}
