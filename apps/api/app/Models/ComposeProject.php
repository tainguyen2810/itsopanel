<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\Bytea;
use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Compose project (D-96): chỉ admin; YAML chỉ chạy bản đã qua validator của agent.
 *
 * @property int $id
 * @property string $uuid
 * @property int $server_id
 * @property string $name
 * @property string $run_state running|stopped|partial|error|deploying
 * @property string|null $template
 * @property string|null $env_encrypted
 * @property int|null $current_revision_id
 * @property int|null $created_by_user_id
 * @property int $spec_version
 * @property int $observed_version
 * @property string $status
 * @property array<array-key, mixed> $observed_facts
 * @property array<array-key, mixed>|null $drift
 * @property Carbon|null $observed_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property Carbon|null $deleted_at
 * @property-read Server $server
 * @property-read ComposeRevision|null $currentRevision
 */
class ComposeProject extends Model
{
    use HasPublicUuid, SoftDeletes;

    protected $table = 'compose_projects';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id', 'env_encrypted'];

    protected function casts(): array
    {
        return ['env_encrypted' => Bytea::class, 'observed_facts' => 'array', 'drift' => 'array', 'observed_at' => 'datetime'];
    }

    /** @return BelongsTo<Server, $this> */
    public function server(): BelongsTo
    {
        return $this->belongsTo(Server::class);
    }

    /** @return BelongsTo<ComposeRevision, $this> */
    public function currentRevision(): BelongsTo
    {
        return $this->belongsTo(ComposeRevision::class, 'current_revision_id');
    }

    /**
     * Tham chiếu project cho op agent (ComposeProjectRef).
     *
     * @return array{project_uuid: string, name: string}
     */
    public function ref(): array
    {
        return ['project_uuid' => $this->uuid, 'name' => $this->name];
    }
}
