<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Một website tìm thấy ở nguồn và kế hoạch map sang ITSO (D-108). Nhiều mục cùng `target_username` gộp vào một account.
 *
 * @property int $id
 * @property string $uuid
 * @property int $import_id
 * @property string $domain
 * @property list<string> $aliases
 * @property string $docroot
 * @property string $vhost_path
 * @property string|null $php_version
 * @property array{cert_path?: string|null, not_after?: string|null, state?: string} $ssl
 * @property int $size_bytes
 * @property list<array{name: string, size_bytes: int}> $databases
 * @property list<array{schedule: string, command: string}> $crons
 * @property string $system_user
 * @property list<array{code: string, message: string}> $warnings
 * @property bool $selected
 * @property string|null $target_username
 * @property int|null $target_package_id
 * @property int|null $target_user_id
 * @property array{name: string, email: string}|null $target_new_user
 * @property int|null $hosting_account_id
 * @property string $state
 * @property int $progress
 * @property array<string, mixed>|null $result
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class ImportItem extends Model
{
    protected $table = 'import_items';

    protected $guarded = ['id', 'uuid'];

    protected function casts(): array
    {
        return ['ssl' => 'array', 'databases' => 'array', 'crons' => 'array', 'warnings' => 'array', 'selected' => 'boolean',
            'target_new_user' => 'array', 'result' => 'array', 'size_bytes' => 'integer', 'progress' => 'integer'];
    }

    /**
     * text[] của PostgreSQL ↔ list PHP.
     *
     * @return list<string>
     */
    public function getAliasesAttribute(mixed $v): array
    {
        if (is_array($v)) {
            return array_values(array_map(fn (mixed $x): string => is_scalar($x) ? (string) $x : '', $v));
        }
        $s = trim(is_string($v) ? $v : '', '{}');

        return $s === '' ? [] : array_map(fn (string $x): string => trim($x, '"'), explode(',', $s));
    }

    /** @param  list<string>  $v */
    public function setAliasesAttribute(array $v): void
    {
        $this->attributes['aliases'] = '{'.implode(',', array_map(fn (string $x): string => '"'.str_replace('"', '', $x).'"', $v)).'}';
    }

    /** @return BelongsTo<PanelImport, $this> */
    public function import(): BelongsTo
    {
        return $this->belongsTo(PanelImport::class, 'import_id');
    }
}
