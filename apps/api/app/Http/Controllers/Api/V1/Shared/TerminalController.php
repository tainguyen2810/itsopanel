<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Shared;

use App\Auth\Access;
use App\Auth\Realm;
use App\Auth\SessionKeys;
use App\Domain\Terminal\TerminalService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\JobPresenter;
use App\Models\Server;
use App\Models\TerminalSession;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

/**
 * POST /admin|portal/terminal/sessions (Prompt 6.4, D-75): step-up ở route. mode=root (Prompt 7.5, ADR 0028): chỉ
 * SUPER_ADMIN ở realm Admin, step-up trong ≤ 10 phút (kể cả khi cấu hình step_up_seconds dài hơn), cần server_uuid.
 */
final class TerminalController extends DataController
{
    public function __construct(Access $access, JobPresenter $jobs, private readonly TerminalService $terminal)
    {
        parent::__construct($access, $jobs);
    }

    public function store(Request $request): JsonResponse
    {
        self::only($request, ['hosting_account_uuid', 'server_uuid', 'mode']);
        $in = $request->validate(['mode' => ['required', 'in:account,root'], 'hosting_account_uuid' => ['sometimes', 'nullable', 'uuid'],
            'server_uuid' => ['sometimes', 'nullable', 'uuid']]);
        if ($in['mode'] === 'root') {
            return $this->root($request, $in['server_uuid'] ?? null);
        }
        if (! isset($in['hosting_account_uuid'])) {
            throw ApiProblem::field('hosting_account_uuid', 'Cần tài khoản hosting cho terminal mode=account.');
        }
        $a = $this->account($request, $in['hosting_account_uuid']);
        $t = $this->terminal->open($this->actor($request), $a);

        return $this->ticket($request, $t, 'account');
    }

    /** Thời gian step-up tối đa cho terminal root (giây). */
    public const ROOT_STEP_UP_SEC = 600;

    private function root(Request $request, ?string $serverUuid): JsonResponse
    {
        $actor = $this->actor($request);
        if ($actor->realm === Realm::PORTAL || $actor->roleKey() !== 'SUPER_ADMIN') {
            throw ApiProblem::forbidden('Chỉ SUPER_ADMIN mở được terminal root.');
        }
        $at = $request->session()->get(SessionKeys::STEP_UP_AT);
        $ttl = min(self::ROOT_STEP_UP_SEC, (int) config('itso.auth.step_up_seconds', 600));
        if (! is_string($at) || Carbon::parse($at)->addSeconds($ttl)->isPast()) {
            throw ApiProblem::stepUpRequired();
        }
        if ($serverUuid === null) {
            throw ApiProblem::field('server_uuid', 'Cần máy chủ cho terminal mode=root.');
        }
        $server = $this->access->servers($actor)->where('servers.uuid', $serverUuid)->first();
        if (! $server instanceof Server) {
            throw ApiProblem::field('server_uuid', 'Máy chủ không tồn tại.');
        }
        $t = $this->terminal->openRoot($actor, $server, (string) $request->ip());

        return $this->ticket($request, $t, 'root');
    }

    /** @param  array{ticket: string, expires_at: string, unix_user: string, session: TerminalSession}  $t */
    private function ticket(Request $request, array $t, string $mode): JsonResponse
    {
        $host = $request->getHttpHost();
        $ws = (string) (config('itso.gateway.ws_url') ?: ($request->isSecure() ? 'wss' : 'ws')."://$host/gateway/terminal");

        return response()->json(['data' => ['ticket' => $t['ticket'], 'ws_url' => $ws, 'expires_at' => $t['expires_at'], 'mode' => $mode,
            'unix_user' => $t['unix_user'], 'session_uuid' => $t['session']->uuid]], 201)->header('Cache-Control', 'no-store');
    }
}
