<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\AuditLog;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use App\Support\PublicId;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * /admin/audit-logs: đọc nhật ký kiểm toán (append-only, hash chain do trigger DB). SUPER_ADMIN thấy tất cả;
 * ADMIN thấy hành động của mình và của tài nguyên/server trong phạm vi. Xuất CSV chống chèn công thức.
 */
final class AuditLogController
{
    private const EXPORT_MAX = 50000;

    /** Bảng (resource_type trong audit_logs) → loại công khai. */
    private const TYPES = ['users' => 'user', 'hosting_accounts' => 'hosting_account', 'servers' => 'server',
        'hosting_packages' => 'hosting_package', 'jobs' => 'job', 'api_tokens' => 'api_token', 'settings' => 'settings',
        'notifications' => 'notification', 'impersonation_sessions' => 'impersonation'];

    public function __construct(private readonly Access $access) {}

    public function index(Request $request): JsonResponse
    {
        $q = $this->query($request);
        Listing::search($request, $q, ['audit_logs.action']);

        return response()->json(Listing::page($request, $q, ['at' => 'audit_logs.at', 'action' => 'audit_logs.action'],
            '-at', fn (AuditLog $l): array => $this->present($l)));
    }

    public function export(Request $request): StreamedResponse
    {
        $q = $this->query($request)->orderByDesc('audit_logs.at')->orderByDesc('audit_logs.id')->limit(self::EXPORT_MAX);
        $name = 'audit-'.now()->format('Ymd-His').'.csv';

        return response()->streamDownload(function () use ($q): void {
            $out = fopen('php://output', 'wb');
            if ($out === false) {
                return;
            }
            fwrite($out, "\xEF\xBB\xBF");
            fputcsv($out, ['at', 'actor', 'impersonator', 'actor_ip', 'action', 'resource', 'result', 'hash'], ',', '"', '');
            foreach ($q->lazyById(500, 'audit_logs.id') as $l) {
                /** @var AuditLog $l */
                $p = $this->present($l);
                fputcsv($out, array_map([self::class, 'csvCell'], [
                    $p['at'], $p['actor']['email'] ?? '', $p['impersonator']['email'] ?? '', $p['actor_ip'] ?? '',
                    $p['action'], $p['resource'] !== null ? $p['resource']['type'].':'.$p['resource']['uuid'] : '',
                    $p['result'], $p['hash'],
                ]), ',', '"', '');
            }
            fclose($out);
        }, $name, ['Content-Type' => 'text/csv; charset=utf-8']);
    }

    /** Chống CSV/formula injection: ô bắt đầu bằng = + - @ tab CR được thêm dấu ' ở đầu. */
    public static function csvCell(mixed $v): string
    {
        $s = (string) $v;

        return $s !== '' && str_contains("=+-@\t\r", $s[0]) ? "'".$s : $s;
    }

    /** @return Builder<AuditLog> */
    private function query(Request $request): Builder
    {
        $request->validate(['filter.action' => ['sometimes', 'string', 'max:100'], 'filter.actor' => ['sometimes', 'uuid']]);
        /** @var User $actor */
        $actor = $request->user();
        $q = AuditLog::query();
        if (! $this->access->isSuperAdmin($actor)) {
            $accounts = $this->access->accounts($actor)->select('hosting_accounts.id');
            $users = $this->access->users($actor)->select('users.id');
            $q->where(function (Builder $w) use ($actor, $accounts, $users): void {
                $w->where('actor_user_id', $actor->id)
                    ->orWhereIn('server_id', $this->access->scopedServerIds($actor) ?: [0])
                    ->orWhere(fn (Builder $r) => $r->where('resource_type', 'hosting_accounts')->whereIn('resource_id', $accounts))
                    ->orWhere(fn (Builder $r) => $r->where('resource_type', 'users')->whereIn('resource_id', $users));
            });
        }
        $action = $request->input('filter.action');
        if (is_string($action) && $action !== '') {
            str_ends_with($action, '*')
                ? $q->where('action', 'like', addcslashes(rtrim($action, '*'), '%_\\').'%')
                : $q->where('action', $action);
        }
        $actorUuid = $request->input('filter.actor');
        if (is_string($actorUuid)) {
            $q->where('actor_user_id', User::query()->where('uuid', $actorUuid)->value('id') ?? 0);
        }

        return $q;
    }

    /** @return array<string, mixed> */
    private function present(AuditLog $l): array
    {
        $user = fn (?int $id): ?array => ($u = $id !== null ? User::query()->find($id) : null) instanceof User
            ? ['uuid' => $u->uuid, 'name' => $u->name, 'email' => $u->email] : null;
        $server = $l->server_id !== null ? Server::query()->find($l->server_id) : null;
        $changes = $l->changes;
        if (is_array($changes) && array_is_list($changes) && $changes !== []) {
            $changes = ['items' => $changes];
        }

        return [
            'uuid' => PublicId::encode('audit', (int) $l->id),
            'at' => $l->at->toIso8601String(),
            'actor' => $user($l->actor_user_id),
            'impersonator' => $user($l->impersonator_user_id),
            'actor_ip' => $l->actor_ip,
            'action' => $l->action,
            'resource' => $this->resource($l),
            'server' => $server instanceof Server ? ['uuid' => $server->uuid, 'name' => $server->name] : null,
            'job_uuid' => $l->job_id !== null ? Job::query()->whereKey($l->job_id)->value('uuid') : null,
            'result' => in_array($l->result, ['success', 'failure', 'denied'], true) ? $l->result : 'failure',
            'changes' => $changes === [] ? (object) [] : $changes,
            'hash' => (string) $l->hash,
        ];
    }

    /** @return array{type: string, uuid: string}|null */
    private function resource(AuditLog $l): ?array
    {
        if ($l->resource_type === null || $l->resource_id === null) {
            return null;
        }
        $type = self::TYPES[$l->resource_type] ?? Str::singular($l->resource_type);
        if (isset(JobPresenter::RESOURCE_MODELS[$type]) || $type === 'job') {
            $uuid = DB::table($l->resource_type)->where('id', $l->resource_id)->value('uuid');

            return is_string($uuid) ? ['type' => $type, 'uuid' => $uuid] : null;
        }

        return ['type' => $type, 'uuid' => PublicId::encode($type, $l->resource_id)];
    }
}
