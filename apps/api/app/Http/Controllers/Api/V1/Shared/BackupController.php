<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Shared;

use App\Auth\Access;
use App\Domain\Backup\BackupService;
use App\Domain\Backup\RestoreService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\BackupPresenter;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\BackupDestination;
use App\Models\BackupSnapshot;
use App\Models\RestoreJob;
use App\Models\Server;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\HeaderUtils;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * /admin|portal: snapshot (list/browse/tải file), backup ngay, khôi phục (Prompt 8.4). Phạm vi theo account
 * (USER chỉ thấy snapshot của account mình); snapshot cấu hình máy chủ/panel chỉ SUPER_ADMIN thấy.
 */
final class BackupController extends DataController
{
    public function __construct(Access $access, JobPresenter $jobs, private readonly BackupService $backups,
        private readonly RestoreService $restores)
    {
        parent::__construct($access, $jobs);
    }

    /** @return Builder<BackupSnapshot> */
    private function snapshots(Request $request): Builder
    {
        $actor = $this->actor($request);
        $q = BackupSnapshot::query();
        $accounts = $this->access->accounts($actor)->select('hosting_accounts.id');
        if ($this->realm($request) === 'admin' && $this->access->can($actor, 'backups.manage')) {
            $q->where(fn (Builder $w) => $w->whereIn('backup_snapshots.hosting_account_id', $accounts)->orWhereNull('backup_snapshots.hosting_account_id'));
        } else {
            $q->whereIn('backup_snapshots.hosting_account_id', $accounts);
        }

        return $q;
    }

    private function snapshot(Request $request, string $id): BackupSnapshot
    {
        $s = Str::isUuid($id) ? $this->snapshots($request)->where('backup_snapshots.uuid', $id)->first() : null;
        if (! $s instanceof BackupSnapshot) {
            throw new NotFoundHttpException;
        }

        return $s;
    }

    public function index(Request $request): JsonResponse
    {
        $request->validate(['filter.hosting_account' => ['sometimes', 'uuid'], 'filter.destination' => ['sometimes', 'uuid'],
            'filter.scope_type' => ['sometimes', 'in:hosting_account,website,database,server_config,panel']]);
        $q = $this->snapshots($request);
        if (is_string($acc = $request->input('filter.hosting_account'))) {
            $q->where('backup_snapshots.hosting_account_id', $this->account($request, $acc, 'filter.hosting_account')->id);
        }
        if (is_string($d = $request->input('filter.destination'))) {
            $q->where('backup_snapshots.destination_id', BackupDestination::query()->where('uuid', $d)->value('id') ?? 0);
        }
        if (is_string($t = $request->input('filter.scope_type'))) {
            $q->where('backup_snapshots.scope_type', $t);
        }
        Listing::search($request, $q, ['backup_snapshots.restic_snapshot_id']);

        return response()->json(Listing::page($request, $q, ['taken_at' => 'backup_snapshots.taken_at', 'size_mb' => 'backup_snapshots.size_bytes'],
            '-taken_at', fn (BackupSnapshot $s): array => BackupPresenter::snapshot($s)));
    }

    public function browse(Request $request, string $id): JsonResponse
    {
        $s = $this->snapshot($request, $id);
        $limit = $request->query('limit', '200');
        if (! is_string($limit) || ! ctype_digit($limit) || (int) $limit < 1 || (int) $limit > 1000) {
            throw ApiProblem::field('limit', 'limit phải là số nguyên 1–1000.');
        }
        $entries = $this->backups->browse($this->actor($request), $s, (string) $request->query('path', '.'), (int) $limit);

        return response()->json(['data' => $entries, 'meta' => ['next_cursor' => null, 'limit' => (int) $limit]]);
    }

    public function downloadLink(Request $request, string $id): JsonResponse
    {
        $s = $this->snapshot($request, $id);
        self::only($request, ['path']);

        return response()->json(['data' => $this->backups->downloadLink($this->actor($request), $s, $request->json('path'), $this->realm($request))])
            ->header('Cache-Control', 'no-store');
    }

    public function raw(Request $request, string $id): StreamedResponse
    {
        $s = $this->snapshot($request, $id);
        $actor = $this->actor($request);
        [$size, $name, $first] = $this->backups->openDownload($actor, $s, $request->query('path'), $request->query('expires'), $request->query('signature'));
        $path = (string) $request->query('path');
        $svc = $this->backups;
        $fallback = preg_replace('/[^A-Za-z0-9._-]/', '_', $name) ?: 'download';

        return new StreamedResponse(function () use ($svc, $actor, $s, $path, $size, $first): void {
            echo $first;
            flush();
            for ($off = strlen($first); $off < $size;) {
                $c = $svc->chunk($actor, $s, $path, $off);
                if ($c['data'] === '') {
                    break;
                }
                echo $c['data'];
                flush();
                $off += strlen($c['data']);
            }
        }, 200, ['Content-Type' => 'application/octet-stream', 'Content-Length' => (string) $size, 'Cache-Control' => 'no-store',
            'X-Content-Type-Options' => 'nosniff',
            'Content-Disposition' => HeaderUtils::makeDisposition(HeaderUtils::DISPOSITION_ATTACHMENT, $name, $fallback)]);
    }

    public function backup(Request $request): JsonResponse
    {
        self::only($request, ['hosting_account_uuid', 'contents', 'note']);
        $in = $request->validate(['hosting_account_uuid' => ['required', 'uuid'], 'contents' => ['required', 'array', 'min:1'],
            'contents.*' => ['string', 'in:files,databases,config'], 'note' => ['sometimes', 'nullable', 'string', 'max:500']]);
        $a = $this->account($request, $in['hosting_account_uuid']);

        return $this->accepted($request, $this->backups->backupNow($this->actor($request), $a, array_values($in['contents']), $in['note'] ?? null));
    }

    /** @return Builder<RestoreJob> */
    private function restoreQuery(Request $request): Builder
    {
        return RestoreJob::query()->whereIn('restore_jobs.hosting_account_id', $this->access->accounts($this->actor($request))->select('hosting_accounts.id'));
    }

    public function restores(Request $request): JsonResponse
    {
        return response()->json(Listing::page($request, $this->restoreQuery($request), ['created_at' => 'restore_jobs.created_at'], '-created_at',
            fn (RestoreJob $r): array => BackupPresenter::restore($r)));
    }

    public function showRestore(Request $request, string $id): JsonResponse
    {
        $r = Str::isUuid($id) ? $this->restoreQuery($request)->where('restore_jobs.uuid', $id)->first() : null;
        if (! $r instanceof RestoreJob) {
            throw new NotFoundHttpException;
        }

        return response()->json(['data' => BackupPresenter::restore($r)])->header('ETag', '"r-'.$r->id.'-'.$r->updated_at->getTimestamp().'"');
    }

    public function restore(Request $request): JsonResponse
    {
        self::only($request, ['snapshot_uuid', 'mode', 'items', 'target_server_uuid', 'confirm']);
        $in = $request->validate(['snapshot_uuid' => ['required', 'uuid'], 'mode' => ['required', 'in:new,overwrite'],
            'items' => ['required', 'array', 'min:1', 'max:50'], 'items.*' => ['string', 'max:1100', 'regex:/^(files:.+|database:[a-z][a-z0-9_]{0,63}|config)$/'],
            'target_server_uuid' => ['sometimes', 'nullable', 'uuid'], 'confirm' => ['sometimes', 'nullable', 'string', 'max:64']]);
        $s = Str::isUuid($in['snapshot_uuid']) ? $this->snapshots($request)->where('backup_snapshots.uuid', $in['snapshot_uuid'])->first() : null;
        if (! $s instanceof BackupSnapshot) {
            throw ApiProblem::field('snapshot_uuid', 'Không tìm thấy snapshot trong phạm vi.');
        }
        $target = null;
        if (! empty($in['target_server_uuid'])) {
            $target = Server::query()->where('uuid', $in['target_server_uuid'])->first();
            if (! $target instanceof Server) {
                throw ApiProblem::field('target_server_uuid', 'Không tìm thấy máy chủ.');
            }
        }
        $rj = $this->restores->create($this->actor($request), $s, $in['mode'], array_values($in['items']), $in['confirm'] ?? null, $target);

        return $this->accepted($request, RestoreService::job($rj) ?? throw new \LogicException('restore không có job'));
    }
}
