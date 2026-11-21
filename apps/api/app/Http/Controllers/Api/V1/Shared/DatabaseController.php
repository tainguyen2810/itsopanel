<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Shared;

use App\Auth\Access;
use App\Domain\Data\DatabaseService;
use App\Http\Presenters\DataPresenter;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\Database;
use App\Models\DatabaseUser;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** /admin|portal/databases/* và /database-users/* (Prompt 6.3). Mật khẩu sinh bởi panel chỉ trả MỘT lần. */
final class DatabaseController extends DataController
{
    private const ENGINE = 'in:mariadb,mysql,postgresql';

    private const NAME = 'max:64';

    public function __construct(Access $access, JobPresenter $jobs, private readonly DatabaseService $service)
    {
        parent::__construct($access, $jobs);
    }

    public function index(Request $request): JsonResponse
    {
        $q = $this->scoped($request, Database::class);
        Listing::search($request, $q, ['databases.name']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'databases.created_at', 'name' => 'databases.name',
            'size_mb' => 'databases.size_mb', 'status' => 'databases.status'], '-created_at',
            fn (Database $d): array => DataPresenter::database($d)));
    }

    public function store(Request $request): JsonResponse
    {
        self::only($request, ['hosting_account_uuid', 'engine', 'name', 'create_user']);
        $in = $request->validate(['hosting_account_uuid' => ['required', 'uuid'], 'engine' => ['required', self::ENGINE],
            'name' => ['required', 'string', self::NAME], 'create_user' => ['sometimes', 'boolean']]);
        [, $job, $secret] = $this->service->create($this->actor($request), $this->account($request, $in['hosting_account_uuid']), $in);

        return $this->accepted($request, $job, $secret);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $d = $this->find($request, Database::class, $id);

        return response()->json(['data' => DataPresenter::database($d)])->header('ETag', DataPresenter::etag($d));
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        return $this->accepted($request, $this->service->delete($this->actor($request), $this->find($request, Database::class, $id)));
    }

    public function export(Request $request, string $id): JsonResponse
    {
        return $this->accepted($request, $this->service->export($this->actor($request), $this->find($request, Database::class, $id)));
    }

    public function import(Request $request, string $id): JsonResponse
    {
        $d = $this->find($request, Database::class, $id);
        self::only($request, ['path']);
        $in = $request->validate(['path' => ['required', 'string', 'max:1024']]);

        return $this->accepted($request, $this->service->import($this->actor($request), $d, (string) $in['path']));
    }

    public function users(Request $request): JsonResponse
    {
        $q = $this->scoped($request, DatabaseUser::class);
        Listing::search($request, $q, ['database_users.username']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'database_users.created_at',
            'username' => 'database_users.username', 'status' => 'database_users.status'], '-created_at',
            fn (DatabaseUser $u): array => DataPresenter::databaseUser($u)));
    }

    public function storeUser(Request $request): JsonResponse
    {
        self::only($request, ['hosting_account_uuid', 'engine', 'username', 'password', 'host', 'max_connections']);
        $in = $request->validate(['hosting_account_uuid' => ['required', 'uuid'], 'engine' => ['required', self::ENGINE],
            'username' => ['required', 'string', self::NAME], 'password' => ['sometimes', 'nullable', 'string', 'max:128'],
            'host' => ['sometimes', 'in:localhost,%'], 'max_connections' => ['sometimes', 'integer', 'min:1', 'max:500']]);
        [, $job, $secret] = $this->service->createUser($this->actor($request), $this->account($request, $in['hosting_account_uuid']), $in);

        return $this->accepted($request, $job, $secret);
    }

    public function destroyUser(Request $request, string $id): JsonResponse
    {
        return $this->accepted($request, $this->service->deleteUser($this->actor($request), $this->find($request, DatabaseUser::class, $id)));
    }

    public function grants(Request $request, string $id): JsonResponse
    {
        $u = $this->find($request, DatabaseUser::class, $id);
        self::only($request, ['grants']);
        $in = $request->validate(['grants' => ['present', 'array', 'max:200'], 'grants.*.database' => ['required', 'string', self::NAME],
            'grants.*.privileges' => ['present', 'array', 'max:20'], 'grants.*.privileges.*' => ['string', 'in:ALL,SELECT,INSERT,UPDATE,DELETE,CREATE,DROP,ALTER,INDEX']]);

        return $this->accepted($request, $this->service->setGrants($this->actor($request), $u, array_values((array) $in['grants'])));
    }

    public function rotatePassword(Request $request, string $id): JsonResponse
    {
        [, $secret] = $this->service->rotatePassword($this->actor($request), $this->find($request, DatabaseUser::class, $id));

        return response()->json(['data' => ['secret' => $secret]])->header('Cache-Control', 'no-store');
    }
}
