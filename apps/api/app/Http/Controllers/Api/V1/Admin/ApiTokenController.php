<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\ApiTokenAuth;
use App\Domain\Audit\AuditLogger;
use App\Exceptions\ApiProblem;
use App\Http\Support\Listing;
use App\Models\ApiToken;
use App\Models\User;
use App\Support\PublicId;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * API token nội bộ của chính mình (CLI, automation). Secret chỉ trả một lần lúc tạo; DB chỉ giữ SHA-256.
 * Bảng api_tokens không có cột uuid → uuid công khai theo App\Support\PublicId.
 */
final class ApiTokenController
{
    private const MAX_PER_USER = 20;

    public function __construct(private readonly AuditLogger $audit) {}

    public static function publicId(int $id): string
    {
        return PublicId::encode('api_token', $id);
    }

    public function index(Request $request): JsonResponse
    {
        $q = ApiToken::query()->where('user_id', $this->actor($request)->id);
        Listing::search($request, $q, ['api_tokens.name']);

        return response()->json(Listing::page($request, $q,
            ['created_at' => 'api_tokens.created_at', 'name' => 'api_tokens.name', 'expires_at' => 'api_tokens.expires_at'],
            '-created_at', fn (ApiToken $t): array => self::present($t)));
    }

    public function store(Request $request): JsonResponse
    {
        $user = $this->actor($request);
        $in = $request->validate([
            'name' => ['required', 'string', 'min:1', 'max:80'],
            'scopes' => ['required', 'array', 'min:1', 'max:50'],
            'scopes.*' => ['required', 'string', 'regex:/^[a-z_]+:(read|write)$/'],
            'expires_at' => ['required', 'date'],
        ]);
        $expires = Carbon::parse((string) $in['expires_at']);
        if ($expires->isPast() || $expires->gt(Carbon::now()->addYear())) {
            throw ApiProblem::field('expires_at', 'Hạn dùng phải trong tương lai và tối đa 1 năm.');
        }
        if (ApiToken::query()->where('user_id', $user->id)->count() >= self::MAX_PER_USER) {
            throw ApiProblem::conflict('Đã đạt số token tối đa ('.self::MAX_PER_USER.').');
        }
        if (ApiToken::query()->where('user_id', $user->id)->where('name', $in['name'])->exists()) {
            throw ApiProblem::conflict('Tên token đã tồn tại.');
        }
        ['plain' => $plain, 'hash' => $hash] = ApiTokenAuth::newToken();
        $token = ApiToken::query()->create([
            'user_id' => $user->id, 'name' => trim((string) $in['name']), 'token_hash' => $hash,
            'scopes' => array_values(array_unique(array_map('strval', $in['scopes']))), 'expires_at' => $expires,
        ]);
        $this->audit->record('api_token.create', $token, ['name' => $token->name, 'scopes' => $token->scopes,
            'expires_at' => $expires->toIso8601String()]);

        return response()->json(['data' => ['secret' => $plain]], 201);
    }

    public function destroy(Request $request, string $id): Response
    {
        $user = $this->actor($request);
        $tokenId = PublicId::decode('api_token', $id);
        $t = $tokenId !== null ? ApiToken::query()->where('user_id', $user->id)->find($tokenId) : null;
        if ($t === null) {
            throw new NotFoundHttpException;
        }
        $this->audit->record('api_token.delete', $t, ['name' => $t->name]);
        $t->delete();

        return response()->noContent();
    }

    /** @return array<string, mixed> */
    public static function present(ApiToken $t): array
    {
        return [
            'uuid' => self::publicId($t->id),
            'name' => $t->name,
            'scopes' => array_values(array_map('strval', $t->scopes)),
            'last_used_at' => $t->last_used_at?->toIso8601String(),
            'expires_at' => ($t->expires_at ?? $t->created_at->copy()->addYear())->toIso8601String(),
            'created_at' => $t->created_at->toIso8601String(),
        ];
    }

    private function actor(Request $request): User
    {
        $u = $request->user();
        if (! $u instanceof User) {
            throw ApiProblem::unauthenticated();
        }

        return $u;
    }
}
