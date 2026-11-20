<?php

declare(strict_types=1);

namespace App\Auth;

use App\Models\ApiToken;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Guard token nội bộ (D-58): `Authorization: Bearer itso_…`, lưu SHA-256, kiểm hết hạn, CIDR, user realm admin còn active.
 */
final class ApiTokenAuth
{
    public const PREFIX = 'itso_';

    public const ATTRIBUTE = 'itso.api_token';

    /** @return array{plain: string, hash: string} */
    public static function newToken(): array
    {
        $plain = self::PREFIX.Str::random(48);

        return ['plain' => $plain, 'hash' => hash('sha256', $plain)];
    }

    public static function user(Request $request): ?User
    {
        $plain = $request->bearerToken();
        if (! is_string($plain) || ! str_starts_with($plain, self::PREFIX) || strlen($plain) > 200) {
            return null;
        }
        $ip = (string) $request->ip();
        /** @var ApiToken|null $token */
        $token = ApiToken::query()
            ->where('token_hash', hash('sha256', $plain))
            ->where(fn ($q) => $q->whereNull('expires_at')->orWhere('expires_at', '>', Carbon::now()))
            ->where(fn ($q) => $q->whereNull('allowed_cidrs')->orWhereRaw('cardinality(allowed_cidrs) = 0')
                ->orWhereRaw('?::inet <<= ANY(allowed_cidrs)', [$ip]))
            ->first();
        if ($token === null) {
            return null;
        }
        /** @var User|null $user */
        $user = User::query()->whereKey($token->user_id)->where('realm', Realm::ADMIN)->where('status', 'active')->first();
        if ($user === null) {
            return null;
        }
        if ($token->last_used_at === null || $token->last_used_at->lt(Carbon::now()->subMinute())) {
            DB::table('api_tokens')->where('id', $token->id)->update(['last_used_at' => Carbon::now()]);
        }
        $request->attributes->set(self::ATTRIBUTE, $token);

        return $user;
    }

    /** Request xác thực bằng token có scope `$scope` (vd. `servers:read`; `x:write` bao gồm `x:read`). */
    public static function allows(ApiToken $token, string $scope): bool
    {
        $scopes = $token->scopes;
        if (in_array($scope, $scopes, true)) {
            return true;
        }
        [$res, $mode] = array_pad(explode(':', $scope, 2), 2, '');

        return $mode === 'read' && in_array("$res:write", $scopes, true);
    }
}
