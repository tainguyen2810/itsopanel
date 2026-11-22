<?php

declare(strict_types=1);

namespace App\Http\Support;

use App\Exceptions\ApiProblem;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

/**
 * Khóa lạc quan (If-Match). Chấp nhận ETag mạnh của tài nguyên hoặc `"<updated_at>"` đúng như trường `updated_at`
 * API trả về (giao diện gửi giá trị này, như bản demo). Không gửi If-Match → không kiểm.
 */
final class IfMatch
{
    public static function check(Request $request, string $etag, ?Carbon $updatedAt, string $title = 'Tài nguyên đã thay đổi'): void
    {
        $m = $request->header('If-Match');
        if (! is_string($m) || $m === '' || $m === '*' || $m === $etag) {
            return;
        }
        $v = trim(str_starts_with($m, 'W/') ? substr($m, 2) : $m, '"');
        if ($updatedAt !== null && preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/', $v) === 1) {
            try {
                if (Carbon::parse($v)->getTimestamp() === $updatedAt->getTimestamp()) {
                    return; // cùng mốc updated_at (độ phân giải giây, như trường API trả về)
                }
            } catch (\Throwable) {
                // giá trị lạ → 412 bên dưới
            }
        }
        throw new ApiProblem(412, 'precondition_failed', $title, 'Tải lại rồi sửa lại.');
    }
}
