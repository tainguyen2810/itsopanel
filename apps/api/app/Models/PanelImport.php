<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * Một lượt import từ panel khác trên cùng máy (D-108, ADR 0053): scanning → planned → running → completed /
 * partially_failed → cut_over → rolled_back; scan_failed khi quét lỗi. Một lượt đang quét/chạy mỗi server
 * (unique index một phần `imports_busy_uq`).
 *
 * @property int $id
 * @property string $uuid
 * @property string $source
 * @property int $server_id
 * @property string $state
 * @property string|null $source_version
 * @property Carbon|null $scanned_at
 * @property string|null $error
 * @property Carbon|null $cutover_at
 * @property int|null $scan_job_id
 * @property int|null $run_job_id
 * @property int|null $created_by_user_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class PanelImport extends Model
{
    public const BUSY = ['scanning', 'running'];

    protected $table = 'imports';

    protected $guarded = ['id', 'uuid'];

    protected function casts(): array
    {
        return ['scanned_at' => 'datetime', 'cutover_at' => 'datetime'];
    }

    /** @return HasMany<ImportItem, $this> */
    public function items(): HasMany
    {
        return $this->hasMany(ImportItem::class, 'import_id');
    }
}
