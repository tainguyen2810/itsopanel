<?php

// Sửa tay (12.5, ADR 0057): trigger itso_audit_hash lấy dòng cuối chuỗi bằng `ORDER BY at DESC, id DESC LIMIT 1` mỗi lần
// chèn; không có chỉ mục (at, id) nên quét toàn bảng → ghi audit chậm dần theo kích thước bảng. Spec (gen_dbml.py) đã thêm
// chỉ mục nên DB mới tạo nó trong migration Phase 3 (tên tự sinh audit_logs_at_id_idx); DB cũ nhận ở đây.

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::statement('CREATE INDEX IF NOT EXISTS audit_logs_at_id_idx ON audit_logs (at, id)');
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS audit_logs_at_id_idx');
    }
};
