<?php

declare(strict_types=1);

namespace App\Domain\Audit;

use Illuminate\Support\Facades\DB;

/** Kiểm chuỗi hash của audit_logs (trigger itso_audit_hash): prev_hash nối tiếp và hash tính lại khớp. */
final class AuditChain
{
    /** @return array{rows: int, broken_id: int|null} */
    public static function verify(): array
    {
        $rows = 0;
        $prev = null;
        foreach (DB::cursor(<<<'SQL'
            SELECT id, prev_hash, hash, encode(sha256(convert_to(
              coalesce(prev_hash, '') || '|' || at::text || '|' || coalesce(actor_user_id::text, '') || '|' ||
              action || '|' || coalesce(resource_type, '') || '|' || coalesce(resource_id::text, '') || '|' ||
              coalesce(changes::text, ''), 'UTF8')), 'hex') AS recomputed
            FROM audit_logs ORDER BY at, id
            SQL) as $r) {
            $rows++;
            if ($r->prev_hash !== $prev || $r->hash !== $r->recomputed) {
                return ['rows' => $rows, 'broken_id' => (int) $r->id];
            }
            $prev = $r->hash;
        }

        return ['rows' => $rows, 'broken_id' => null];
    }
}
