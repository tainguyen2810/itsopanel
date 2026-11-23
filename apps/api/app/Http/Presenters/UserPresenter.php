<?php

declare(strict_types=1);

namespace App\Http\Presenters;

use App\Auth\Access;
use App\Auth\MfaService;
use App\Auth\SessionKeys;
use App\Models\ImpersonationSession;
use App\Models\MfaCredential;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/** Biểu diễn User / Me theo contracts/openapi/common.yaml. */
final class UserPresenter
{
    /** @var array<int, int>|null user_id có TOTP của trang đang trình bày (prefetch, chặn N+1). */
    private ?array $mfaUsers = null;

    public function __construct(private readonly MfaService $mfa, private readonly Access $access) {}

    /**
     * Nạp trước trạng thái MFA cho một trang danh sách; trả closure dọn dẹp (Listing::page gọi sau khi trình bày).
     *
     * @param  list<User>  $users
     */
    public function prefetch(array $users): \Closure
    {
        $ids = array_map(fn (User $u): int => $u->id, $users) ?: [0];
        $this->mfaUsers = array_flip(array_map('intval', MfaCredential::query()->whereIn('user_id', $ids)->where('type', 'totp')
            ->distinct()->pluck('user_id')->all()));

        return function (): void {
            $this->mfaUsers = null;
        };
    }

    /** @return array<string, mixed> */
    public function user(User $u): array
    {
        return [
            'uuid' => $u->uuid,
            'realm' => $u->realm,
            'name' => $u->name,
            'email' => $u->email,
            'role' => $u->roleKey() ?? ($u->realm === 'admin' ? 'ADMIN' : 'USER'),
            'status' => $u->status,
            'mfa_enabled' => $this->mfaUsers !== null ? isset($this->mfaUsers[$u->id]) : $this->mfa->enabled($u),
            'locale' => in_array($u->locale, ['vi', 'en'], true) ? $u->locale : 'vi',
            'timezone' => $u->timezone,
            'last_login_at' => $u->last_login_at?->toIso8601String(),
            'created_at' => $u->created_at->toIso8601String(),
            'updated_at' => $u->updated_at->toIso8601String(),
        ];
    }

    /** @return array<string, mixed> */
    public function me(User $u, Request $request): array
    {
        $mfaAt = $request->hasSession() ? $request->session()->get(SessionKeys::MFA_VERIFIED_AT) : null;

        return [
            'user' => $this->user($u),
            'permissions' => $this->permissions($u),
            'scopes' => $this->scopes($u),
            'mfa_verified_at' => is_string($mfaAt) ? $mfaAt : null,
            'impersonating' => $this->impersonator($request),
        ];
    }

    /** @return array{uuid: string, name: string, email: string}|null */
    private function impersonator(Request $request): ?array
    {
        $id = $request->hasSession() ? $request->session()->get(SessionKeys::IMPERSONATION_ID) : null;
        if (! is_int($id)) {
            return null;
        }
        $imp = ImpersonationSession::query()->find($id);
        $staff = $imp !== null ? User::query()->find($imp->staff_user_id) : null;

        return $staff instanceof User ? $this->ref($staff) : null;
    }

    /** @return list<string> */
    public function permissions(User $u): array
    {
        return $this->access->permissions($u);
    }

    /**
     * UserRef (uuid, name, email).
     *
     * @return array{uuid: string, name: string, email: string}
     */
    public function ref(User $u): array
    {
        return ['uuid' => $u->uuid, 'name' => $u->name, 'email' => $u->email];
    }

    /** @return list<array{scope_type: string, uuid: string, name: string}> */
    public function scopes(User $u): array
    {
        $servers = DB::table('user_scopes')->join('servers', 'servers.id', '=', 'user_scopes.scope_id')
            ->where('user_scopes.user_id', $u->id)->where('user_scopes.scope_type', 'server')
            ->orderBy('servers.name')->get(['servers.uuid', 'servers.name']);
        $accounts = DB::table('user_scopes')->join('hosting_accounts', 'hosting_accounts.id', '=', 'user_scopes.scope_id')
            ->where('user_scopes.user_id', $u->id)->where('user_scopes.scope_type', 'hosting_account')
            ->orderBy('hosting_accounts.username')->get(['hosting_accounts.uuid', 'hosting_accounts.username as name']);
        $out = [];
        foreach ($servers as $s) {
            $out[] = ['scope_type' => 'server', 'uuid' => (string) $s->uuid, 'name' => (string) $s->name];
        }
        foreach ($accounts as $a) {
            $out[] = ['scope_type' => 'hosting_account', 'uuid' => (string) $a->uuid, 'name' => (string) $a->name];
        }

        return $out;
    }
}
