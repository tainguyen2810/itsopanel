<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\System\ProductionReadiness;
use Illuminate\Console\Command;

/** Ghi kết quả một bài Production Gate (D-115) sau khi chạy tests/vm/gate.sh; trang Sẵn sàng production đọc lại. */
final class GateRecordCommand extends Command
{
    protected $signature = 'itso:gate-record {id : G1…G8} {status : pass|fail|partial|pending_vm} {--note= : ghi chú ngắn (đường dẫn báo cáo)}';

    protected $description = 'Ghi trạng thái một bài Production Gate G1–G8 (bằng chứng VM)';

    public function handle(): int
    {
        $id = (string) $this->argument('id');
        $status = (string) $this->argument('status');
        if (! isset(ProductionReadiness::GATE[$id]) || ! in_array($status, ProductionReadiness::GATE_STATUSES, true)) {
            $this->error('id phải là G1…G8, status là pass|fail|partial|pending_vm');

            return self::FAILURE;
        }
        $note = $this->option('note');
        ProductionReadiness::record($id, $status, is_string($note) ? $note : null);
        $this->info("$id → $status");

        return self::SUCCESS;
    }
}
