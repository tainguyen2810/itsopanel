<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Cache container quan sát từ agent (bảng `containers`), làm mới khi đọc danh sách.
 *
 * @property int $id
 * @property int $server_id
 * @property string $docker_id
 * @property string $name
 * @property string $image
 * @property string|null $image_digest
 * @property int|null $project_id
 * @property string|null $service
 * @property string|null $state
 * @property string|null $health
 * @property list<string> $ports
 * @property Carbon $observed_at
 */
class DockerContainer extends Model
{
    public $timestamps = false;

    protected $table = 'containers';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['ports' => 'array', 'observed_at' => 'datetime'];
    }
}
