<?php

// Sửa tay (12.1): migration Phase 10/11 sinh trước 12.1 nhân đôi dấu \ trong nowdoc nên hai CHECK chặn traversal
// thành regex sai (không chặn gì). DB đã migrate trước đó được tạo lại đúng ràng buộc theo extras.sql; DB mới
// (migration đã sinh lại) chạy lệnh này cũng không đổi gì.

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::unprepared(<<<'SQL'
ALTER TABLE wordpress_sites DROP CONSTRAINT IF EXISTS wordpress_sites_path_chk;
ALTER TABLE wordpress_sites ADD CONSTRAINT wordpress_sites_path_chk CHECK (path !~ '(^/|(^|/)\.\.(/|$))');
ALTER TABLE uptime_checks DROP CONSTRAINT IF EXISTS uptime_checks_path_chk;
ALTER TABLE uptime_checks ADD CONSTRAINT uptime_checks_path_chk
  CHECK (path ~ '^/' AND path !~ '//' AND path !~ '(^|/)\.\.?(/|\?|$)' AND length(path) <= 200);
SQL);
    }

    public function down(): void
    {
        // Không quay lại ràng buộc sai.
    }
};
