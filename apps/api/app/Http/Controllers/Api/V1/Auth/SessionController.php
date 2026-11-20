<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Auth;

use App\Auth\Realm;
use App\Auth\SessionRepository;
use App\Exceptions\ApiProblem;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/** Phiên đăng nhập của chính user (trong realm hiện tại). */
final class SessionController
{
    public function __construct(private readonly SessionRepository $sessions) {}

    public function index(Request $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();
        $current = $request->session()->getId();
        $data = array_map(fn (array $s): array => [
            'uuid' => $s['uuid'],
            'ip' => $s['ip'],
            'user_agent' => $s['user_agent'],
            'current' => $s['id'] === $current,
            'last_active_at' => $s['last_active_at']->toIso8601String(),
            'created_at' => $s['created_at']->toIso8601String(),
        ], $this->sessions->forUser($user, Realm::of($request)));

        return response()->json(['data' => $data, 'meta' => ['next_cursor' => null, 'limit' => max(1, min(200, count($data)))]]);
    }

    public function destroy(Request $request, string $id): Response
    {
        /** @var User $user */
        $user = $request->user();
        foreach ($this->sessions->forUser($user, Realm::of($request)) as $s) {
            if (hash_equals($s['uuid'], strtolower($id))) {
                if ($s['id'] === $request->session()->getId()) {
                    throw ApiProblem::conflict('Đây là phiên hiện tại: dùng đăng xuất (POST /auth/logout).');
                }
                $this->sessions->delete($s['id']);

                return response()->noContent();
            }
        }
        throw new NotFoundHttpException;
    }
}
