<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Realm;
use App\Domain\Imports\ImportService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\BackupPresenter;
use App\Http\Presenters\HostingPresenter;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\HostingPackage;
use App\Models\ImportItem;
use App\Models\Job;
use App\Models\PanelImport;
use App\Models\Server;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Import từ panel khác trên cùng máy (Prompt 12.3, D-108, ADR 0053). Chỉ SUPER_ADMIN (imports.manage);
 * chạy/cutover/quay lại cần step-up. Máy nguồn không bị sửa trước cutover.
 */
final class ImportController
{
    public function __construct(private readonly ImportService $svc, private readonly JobPresenter $jobs) {}

    public function index(Request $request): JsonResponse
    {
        $q = PanelImport::query();
        Listing::search($request, $q, ['imports.source', 'imports.state']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'imports.created_at', 'updated_at' => 'imports.updated_at',
            'state' => 'imports.state'], '-created_at', fn (PanelImport $i): array => self::present($i)));
    }

    public function store(Request $request): JsonResponse
    {
        $in = $request->validate(['source' => ['required', 'string', 'in:'.implode(',', ImportService::SOURCES)],
            'server' => ['required', 'uuid']]);
        $server = Server::query()->where('uuid', $in['server'])->first();
        if (! $server instanceof Server) {
            throw ApiProblem::field('server', 'Không có server này.');
        }

        return $this->accepted($this->svc->scan($this->actor($request), $in['source'], $server));
    }

    public function show(string $id): JsonResponse
    {
        $i = $this->find($id);

        return response()->json(['data' => self::present($i)])
            ->header('ETag', '"imp-'.substr(hash('sha256', $i->uuid.'|'.$i->updated_at->format('U.u')), 0, 16).'"');
    }

    public function destroy(Request $request, string $id): Response
    {
        $this->svc->delete($this->actor($request), $this->find($id));

        return response()->noContent();
    }

    public function items(Request $request, string $id): JsonResponse
    {
        $imp = $this->find($id);
        $q = ImportItem::query()->where('import_id', $imp->id);
        Listing::search($request, $q, ['import_items.domain', 'import_items.docroot']);

        return response()->json(Listing::page($request, $q, ['domain' => 'import_items.domain', 'created_at' => 'import_items.id',
            'state' => 'import_items.state'], 'created_at', fn (ImportItem $it): array => self::item($it, $imp)));
    }

    public function plan(Request $request, string $id): JsonResponse
    {
        $imp = $this->find($id);
        $in = $request->validate([
            'items' => ['required', 'array', 'min:1', 'max:500'],
            'items.*' => ['array:uuid,selected,username,package,user,new_user'],
            'items.*.uuid' => ['required', 'uuid'],
            'items.*.selected' => ['required', 'boolean'],
            'items.*.username' => ['sometimes', 'string', 'min:3', 'max:16'],
            'items.*.package' => ['sometimes', 'uuid'],
            'items.*.user' => ['sometimes', 'nullable', 'uuid'],
            'items.*.new_user' => ['sometimes', 'nullable', 'array:name,email'],
            'items.*.new_user.name' => ['required_with:items.*.new_user', 'string', 'min:2', 'max:120'],
            'items.*.new_user.email' => ['required_with:items.*.new_user', 'email', 'max:190'],
        ]);

        return response()->json(['data' => self::present($this->svc->plan($this->actor($request), $imp, array_values($in['items'])))]);
    }

    public function run(Request $request, string $id): JsonResponse
    {
        $jobs = $this->svc->run($this->actor($request), $this->find($id));

        return $this->accepted($jobs[0]);
    }

    public function cutover(Request $request, string $id): JsonResponse
    {
        return $this->accepted($this->svc->cutover($this->actor($request), $this->find($id)));
    }

    public function rollback(Request $request, string $id): JsonResponse
    {
        return $this->accepted($this->svc->rollback($this->actor($request), $this->find($id)));
    }

    /** @return array<string, mixed> */
    public static function present(PanelImport $i): array
    {
        $s = Server::withTrashed()->find($i->server_id);
        $items = ImportItem::query()->where('import_id', $i->id)->get(['databases', 'crons', 'warnings', 'selected']);

        return ['uuid' => $i->uuid, 'source' => $i->source,
            'server' => $s instanceof Server ? ['uuid' => $s->uuid, 'name' => $s->name] : ['uuid' => '00000000-0000-4000-8000-000000000000', 'name' => '?'],
            'state' => $i->state, 'source_version' => $i->source_version, 'scanned_at' => $i->scanned_at?->toIso8601String(),
            'error' => $i->error,
            'summary' => ['sites' => $items->count(), 'databases' => (int) $items->sum(fn (ImportItem $x): int => count($x->databases)),
                'crons' => (int) $items->sum(fn (ImportItem $x): int => count($x->crons)),
                'warnings' => (int) $items->sum(fn (ImportItem $x): int => count($x->warnings)),
                'selected' => $items->where('selected', true)->count()],
            'cutover_at' => $i->cutover_at?->toIso8601String(),
            'created_by' => HostingPresenter::userRef(User::query()->find($i->created_by_user_id)),
            'created_at' => $i->created_at->toIso8601String(), 'updated_at' => $i->updated_at->toIso8601String()];
    }

    /** @return array<string, mixed> */
    public static function item(ImportItem $it, PanelImport $imp): array
    {
        $pkg = $it->target_package_id !== null ? HostingPackage::query()->find($it->target_package_id) : null;
        $ver = $pkg instanceof HostingPackage ? $pkg->versions()->orderByDesc('version')->first() : null;
        $user = $it->target_user_id !== null ? User::query()->find($it->target_user_id) : null;
        $notAfter = $it->ssl['not_after'] ?? null;
        $r = $it->result;
        $hasResult = is_array($r) && array_key_exists('files', $r);

        return ['uuid' => $it->uuid, 'import_uuid' => $imp->uuid, 'domain' => $it->domain, 'aliases' => $it->aliases,
            'docroot' => $it->docroot, 'php_version' => $it->php_version, 'ssl' => (string) ($it->ssl['state'] ?? 'none'),
            'ssl_expires_at' => $notAfter !== null ? Carbon::parse((string) $notAfter)->toIso8601String() : null,
            'size_mb' => intdiv($it->size_bytes, 1048576),
            'databases' => array_map(fn (array $d): array => ['name' => (string) $d['name'], 'size_mb' => intdiv((int) $d['size_bytes'], 1048576)], $it->databases),
            'crons' => count($it->crons), 'system_user' => $it->system_user, 'warnings' => $it->warnings, 'selected' => $it->selected,
            'target' => ['username' => (string) $it->target_username,
                'package' => $pkg instanceof HostingPackage && $ver !== null ? HostingPresenter::packageRef($pkg, $ver) : null,
                'user' => $user instanceof User ? HostingPresenter::userRef($user) : null, 'new_user' => $it->target_new_user],
            'state' => $it->state, 'progress' => $it->progress,
            'result' => $hasResult ? ['hosting_account' => BackupPresenter::accountRef(isset($r['hosting_account_id']) ? (int) $r['hosting_account_id'] : null),
                'files' => (int) $r['files'], 'bytes' => (int) $r['bytes'], 'skipped' => (int) $r['skipped'],
                'skipped_reasons' => array_values((array) $r['skipped_reasons']), 'db_tables' => (int) $r['db_tables'],
                'db_rows_match' => (bool) $r['db_rows_match'], 'certificate' => $r['certificate'] ?? null, 'error' => $r['error'] ?? null] : null];
    }

    private function find(string $id): PanelImport
    {
        $i = Str::isUuid($id) ? PanelImport::query()->where('uuid', $id)->first() : null;
        if (! $i instanceof PanelImport) {
            throw new NotFoundHttpException;
        }

        return $i;
    }

    private function accepted(Job $job): JsonResponse
    {
        $data = $this->jobs->job($job->refresh(), Realm::ADMIN);

        return response()->json(['job' => $data, 'resource' => $data['resource']], 202);
    }

    private function actor(Request $request): User
    {
        /** @var User */
        return $request->user();
    }
}
