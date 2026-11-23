<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Một lượt kiểm CIS Ubuntu 24.04 L1 (D-109, ADR 0054): chỉ đọc, giữ 30 lượt gần nhất mỗi server.
 *
 * @property int $id
 * @property int $server_id
 * @property string $profile
 * @property int $score
 * @property int $passed
 * @property int $failed
 * @property int $not_applicable
 * @property list<array{id: string, group: string, title: string, status: string, evidence: string}> $items
 * @property int|null $job_id
 * @property Carbon $audited_at
 */
class CisResult extends Model
{
    public $timestamps = false;

    protected $table = 'cis_results';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['items' => 'array', 'audited_at' => 'datetime', 'score' => 'integer', 'passed' => 'integer', 'failed' => 'integer',
            'not_applicable' => 'integer'];
    }
}
