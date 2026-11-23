<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Audit\AuditLogger;
use App\Domain\Users\UserService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\UserPresenter;
use App\Http\Support\IfMatch;
use App\Http\Support\Listing;
use App\Models\HostingAccount;
use App\Models\MfaCredential;
use App\Models\Server;
use App\Models\User;
use App\Models\UserScope;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * /admin/users (Prompt 3.3). SUPER_ADMIN quản lý mọi user; ADMIN chỉ thấy/tạo/sửa USER Portal trong phạm vi
 * (chủ account trong phạm vi hoặc do mình tạo). Ngoài phạm vi → 404, thiếu quyền → 403.
 */
final class UserController
{
    private const ROLE_REALM = ['SUPER_ADMIN' => 'admin', 'ADMIN' => 'admin', 'USER' => 'portal'];

    public function __construct(
        private readonly Access $access,
        private readonly UserPresenter $present,
        private readonly UserService $users,
        private readonly AuditLogger $audit,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $request->validate(['filter.realm' => ['sometimes', 'in:admin,portal']]);
        $q = $this->access->users($this->actor($request))->with('roles');
        $realm = $request->input('filter.realm');
        if (is_string($realm)) {
            $q->where('realm', $realm);
        }
        Listing::search($request, $q, ['users.name', 'users.email']);

        return response()->json(Listing::page($request, $q,
            ['created_at' => 'users.created_at', 'name' => 'users.name', 'email' => 'users.email',
                'last_login_at' => 'users.last_login_at'],
            '-created_at', fn (User $u): array => $this->present->user($u), fn (array $page) => $this->present->prefetch($page)));
    }

    public function store(Request $request): JsonResponse
    {
        $actor = $this->actor($request);
        $in = $request->validate([
            'realm' => ['required', 'in:admin,portal'],
            'name' => ['required', 'string', 'min:1', 'max:120'],
            'email' => ['required', 'string', 'email', 'max:254'],
            'role' => ['required', 'in:SUPER_ADMIN,ADMIN,USER'],
            'locale' => ['sometimes', 'in:vi,en'],
            'send_invite' => ['sometimes', 'boolean'],
        ]);
        if (self::ROLE_REALM[$in['role']] !== $in['realm']) {
            throw ApiProblem::field('role', 'Vai trò không khớp realm.');
        }
        if (! $this->access->isSuperAdmin($actor) && $in['role'] !== 'USER') {
            throw ApiProblem::forbidden('ADMIN chỉ tạo được USER Portal.');
        }
        $email = mb_strtolower(trim((string) $in['email']));
        if (User::query()->where('email', $email)->exists()) {
            throw ApiProblem::conflict('Email đã được dùng.');
        }
        $user = DB::transaction(function () use ($in, $email, $actor): User {
            $u = User::query()->create([
                'realm' => $in['realm'], 'name' => trim((string) $in['name']), 'email' => $email,
                'password_hash' => UserService::unusablePassword(), 'locale' => $in['locale'] ?? 'vi',
                'status' => 'active', 'created_by_user_id' => $actor->id,
            ]);
            $this->users->setRole($u, (string) $in['role']);

            return $u;
        });
        if (($in['send_invite'] ?? false) === true) {
            $this->users->sendPasswordLink($user, (int) config('itso.auth.invite_hours', 72) * 60);
        }
        $this->audit->record('user.create', $user, ['realm' => $user->realm, 'email' => $user->email, 'role' => $in['role']]);

        return $this->userResponse($user->fresh() ?? $user, 201);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        return $this->userResponse($this->target($request, $id));
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $actor = $this->actor($request);
        $user = $this->target($request, $id);
        $this->requireManageable($actor, $user);
        $etag = self::etag($user);
        IfMatch::check($request, $etag, $user->updated_at, 'Phiên bản đã thay đổi');
        $in = $request->validate([
            'name' => ['sometimes', 'string', 'min:1', 'max:120'],
            'email' => ['sometimes', 'string', 'email', 'max:254'],
            'locale' => ['sometimes', 'in:vi,en'],
            'role' => ['sometimes', 'in:SUPER_ADMIN,ADMIN,USER'],
        ]);
        $before = ['name' => $user->name, 'email' => $user->email, 'locale' => $user->locale, 'role' => $user->roleKey()];
        DB::transaction(function () use ($in, $user, $actor): void {
            if (isset($in['email'])) {
                $email = mb_strtolower(trim((string) $in['email']));
                if (User::query()->where('email', $email)->where('id', '!=', $user->id)->exists()) {
                    throw ApiProblem::conflict('Email đã được dùng.');
                }
                $user->email = $email;
            }
            if (isset($in['name'])) {
                $user->name = trim((string) $in['name']);
            }
            if (isset($in['locale'])) {
                $user->locale = (string) $in['locale'];
            }
            if (isset($in['role']) && $in['role'] !== $user->roleKey()) {
                if (self::ROLE_REALM[$in['role']] !== $user->realm) {
                    throw ApiProblem::field('role', 'Vai trò không khớp realm (realm không đổi được).');
                }
                if (! $this->access->isSuperAdmin($actor)) {
                    throw ApiProblem::forbidden('Chỉ SUPER_ADMIN đổi vai trò.');
                }
                $this->users->guardLastSuperAdmin($user);
                $this->users->setRole($user, (string) $in['role']);
            }
            $user->save();
        });
        $user->refresh();
        $after = ['name' => $user->name, 'email' => $user->email, 'locale' => $user->locale, 'role' => $user->roleKey()];
        $this->audit->record('user.update', $user, ['before' => $before, 'after' => $after]);

        return $this->userResponse($user);
    }

    public function lock(Request $request, string $id): JsonResponse
    {
        return $this->setStatus($request, $id, 'locked');
    }

    public function unlock(Request $request, string $id): JsonResponse
    {
        return $this->setStatus($request, $id, 'active');
    }

    public function resetMfa(Request $request, string $id): JsonResponse
    {
        $actor = $this->actor($request);
        $user = $this->target($request, $id);
        $this->requireManageable($actor, $user);
        if ($user->id === $actor->id) {
            throw ApiProblem::conflict('Không tự đặt lại MFA của mình qua API này.');
        }
        DB::transaction(function () use ($user): void {
            MfaCredential::query()->where('user_id', $user->id)->delete();
            $this->users->revokeSessions($user);
        });
        $this->audit->record('user.mfa_reset', $user);

        return $this->userResponse($user->refresh());
    }

    public function scopes(Request $request, string $id): JsonResponse
    {
        $user = $this->target($request, $id);
        $data = $this->present->scopes($user);

        return response()->json(['data' => $data, 'meta' => ['next_cursor' => null, 'limit' => max(1, min(200, count($data)))]]);
    }

    public function setScopes(Request $request, string $id): JsonResponse
    {
        $user = $this->target($request, $id);
        $in = $request->validate([
            'scopes' => ['present', 'array', 'max:500'],
            'scopes.*.scope_type' => ['required', 'in:server,hosting_account'],
            'scopes.*.uuid' => ['required', 'uuid'],
        ]);
        if ($user->roleKey() !== 'ADMIN') {
            throw ApiProblem::field('scopes', 'Chỉ gán phạm vi cho user vai trò ADMIN.');
        }
        $rows = [];
        foreach ($in['scopes'] as $i => $s) {
            $model = $s['scope_type'] === 'server' ? Server::query() : HostingAccount::query();
            $sid = $model->where('uuid', $s['uuid'])->value('id');
            if ($sid === null) {
                throw ApiProblem::field("scopes.$i.uuid", 'Không tìm thấy tài nguyên.');
            }
            $rows[$s['scope_type'].':'.$sid] = ['scope_type' => $s['scope_type'], 'scope_id' => (int) $sid];
        }
        $before = $this->present->scopes($user);
        DB::transaction(function () use ($user, $rows): void {
            UserScope::query()->where('user_id', $user->id)->delete();
            foreach ($rows as $r) {
                UserScope::query()->create(['user_id' => $user->id] + $r);
            }
        });
        $after = $this->present->scopes($user);
        $this->audit->record('user.scopes_set', $user, ['before' => $before, 'after' => $after]);

        return response()->json(['data' => $after]);
    }

    private function setStatus(Request $request, string $id, string $status): JsonResponse
    {
        $actor = $this->actor($request);
        $user = $this->target($request, $id);
        $this->requireManageable($actor, $user);
        if ($user->id === $actor->id) {
            throw ApiProblem::conflict('Không tự khóa/mở khóa chính mình.');
        }
        if ($user->status === $status) {
            return $this->userResponse($user);
        }
        DB::transaction(function () use ($user, $status): void {
            if ($status !== 'active') {
                $this->users->guardLastSuperAdmin($user);
            }
            $user->status = $status;
            $user->save();
            if ($status === 'active') {
                // Mở khóa xóa luôn bộ đếm đăng nhập sai.
                DB::table('login_attempts')->where('realm', $user->realm)->where('email', $user->email)
                    ->where('success', false)->delete();
            } else {
                $this->users->revokeSessions($user);
            }
        });
        $this->audit->record($status === 'active' ? 'user.unlock' : 'user.lock', $user);

        return $this->userResponse($user->refresh());
    }

    private function actor(Request $request): User
    {
        $u = $request->user();
        if (! $u instanceof User) {
            throw ApiProblem::unauthenticated();
        }

        return $u;
    }

    /** User đích trong phạm vi actor; ngoài phạm vi hoặc không tồn tại → 404. */
    private function target(Request $request, string $id): User
    {
        if (! Str::isUuid($id)) {
            throw new NotFoundHttpException;
        }
        $u = $this->access->users($this->actor($request))->where('users.uuid', $id)->with('roles')->first();
        if (! $u instanceof User) {
            throw new NotFoundHttpException;
        }

        return $u;
    }

    /** ADMIN chỉ sửa USER Portal (kể cả không sửa ADMIN khác hay chính mình qua đây). */
    private function requireManageable(User $actor, User $target): void
    {
        if (! $this->access->isSuperAdmin($actor) && $target->realm !== Realm::PORTAL) {
            throw ApiProblem::forbidden('ADMIN chỉ quản lý USER Portal.');
        }
    }

    private static function etag(User $u): string
    {
        return 'W/"'.sha1($u->id.'|'.$u->updated_at->format('Y-m-d\TH:i:s.uP')).'"';
    }

    private function userResponse(User $user, int $status = 200): JsonResponse
    {
        return response()->json(['data' => $this->present->user($user)], $status)->header('ETag', self::etag($user));
    }
}
