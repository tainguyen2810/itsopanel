<?php

declare(strict_types=1);

namespace App\Auth;

use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;

/**
 * Quyền + phạm vi dữ liệu (D-58, Prompt 3.3).
 *
 * - SUPER_ADMIN thấy mọi thứ.
 * - ADMIN thấy server trong `user_scopes(server)` và account thuộc các server đó hoặc trong `user_scopes(hosting_account)`;
 *   thấy USER Portal sở hữu account trong phạm vi hoặc do chính mình tạo.
 * - USER chỉ thấy tài nguyên `owner_user_id = mình` (global scope Portal).
 * Ngoài phạm vi trả 404 (không lộ sự tồn tại); thiếu quyền trả 403.
 */
final class Access
{
    /** @var array<int, list<string>> */
    private array $permCache = [];

    /** @return list<string> */
    public function permissions(User $u): array
    {
        return $this->permCache[$u->id] ??= array_values(DB::table('user_roles')
            ->join('role_permissions', 'role_permissions.role_id', '=', 'user_roles.role_id')
            ->join('permissions', 'permissions.id', '=', 'role_permissions.permission_id')
            ->where('user_roles.user_id', $u->id)->orderBy('permissions.key')
            ->pluck('permissions.key')->map(fn ($k): string => (string) $k)->all());
    }

    public function can(User $u, string $permission): bool
    {
        return Permissions::grants($this->permissions($u), $permission);
    }

    public function isSuperAdmin(User $u): bool
    {
        return $u->roleKey() === 'SUPER_ADMIN';
    }

    /** @return list<int> server id trong phạm vi ADMIN */
    public function scopedServerIds(User $u): array
    {
        return array_values(array_map('intval', DB::table('user_scopes')->where('user_id', $u->id)
            ->where('scope_type', 'server')->pluck('scope_id')->all()));
    }

    /**
     * Query servers mà user realm admin được thấy (SA: mọi server; ADMIN: server trong phạm vi).
     *
     * @return Builder<Server>
     */
    public function servers(User $u): Builder
    {
        $q = Server::query();
        if ($this->isSuperAdmin($u)) {
            return $q;
        }
        if ($u->realm !== Realm::ADMIN) {
            return $q->whereRaw('false');
        }

        return $q->whereIn('servers.id', $this->scopedServerIds($u) ?: [0]);
    }

    /**
     * Query hosting_accounts mà user được thấy.
     *
     * @return Builder<HostingAccount>
     */
    public function accounts(User $u): Builder
    {
        $q = HostingAccount::query();
        if ($this->isSuperAdmin($u)) {
            return $q;
        }
        if ($u->realm === Realm::PORTAL) {
            return $q->where('owner_user_id', $u->id);
        }
        $servers = $this->scopedServerIds($u);
        $accounts = DB::table('user_scopes')->where('user_id', $u->id)->where('scope_type', 'hosting_account')->pluck('scope_id')->all();

        return $q->where(fn (Builder $w) => $w->whereIn('server_id', $servers ?: [0])->orWhereIn('id', $accounts ?: [0]));
    }

    /**
     * Query user mà actor (realm admin) được thấy trong /admin/users.
     *
     * @return Builder<User>
     */
    public function users(User $actor): Builder
    {
        $q = User::query();
        if ($this->isSuperAdmin($actor)) {
            return $q;
        }
        $owners = $this->accounts($actor)->select('owner_user_id');

        return $q->where(fn (Builder $w) => $w->where('users.id', $actor->id)
            ->orWhere(fn (Builder $p) => $p->where('realm', Realm::PORTAL)
                ->where(fn (Builder $o) => $o->whereIn('users.id', $owners)->orWhere('created_by_user_id', $actor->id))));
    }

    /**
     * Job user được thấy: SA mọi job; ADMIN job trên server trong phạm vi, job của account trong phạm vi
     * hoặc job mình tạo; USER job của account mình sở hữu hoặc mình tạo.
     *
     * @return Builder<Job>
     */
    public function jobs(User $u): Builder
    {
        $q = Job::query();
        if ($this->isSuperAdmin($u)) {
            return $q;
        }
        $accounts = $this->accounts($u)->select('hosting_accounts.id');

        return $q->where(function (Builder $w) use ($u, $accounts): void {
            $w->where('requested_by_user_id', $u->id)
                ->orWhere(fn (Builder $r) => $r->where('resource_type', 'hosting_account')->whereIn('resource_id', $accounts));
            if ($u->realm === Realm::ADMIN) {
                $w->orWhereIn('server_id', $this->scopedServerIds($u) ?: [0]);
            }
        });
    }

    public function canSeeUser(User $actor, User $target): bool
    {
        return $this->users($actor)->whereKey($target->id)->exists();
    }
}
