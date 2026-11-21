<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Shared;

use App\Auth\Access;
use App\Domain\Terminal\TerminalService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\JobPresenter;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** POST /admin|portal/terminal/sessions (Prompt 6.4, D-75): step-up ở route; chỉ mode=account ở Phase 6. */
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
            throw new ApiProblem(409, 'conflict', 'Chưa có ở phiên bản này', 'Terminal root theo policy cục bộ thuộc Phase 7; Phase 6 chỉ mở terminal của account.');
        }
        if (! isset($in['hosting_account_uuid'])) {
            throw ApiProblem::field('hosting_account_uuid', 'Cần tài khoản hosting cho terminal mode=account.');
        }
        $a = $this->account($request, $in['hosting_account_uuid']);
        $t = $this->terminal->open($this->actor($request), $a);
        $host = $request->getHttpHost();
        $ws = (string) (config('itso.gateway.ws_url') ?: ($request->isSecure() ? 'wss' : 'ws')."://$host/gateway/terminal");

        return response()->json(['data' => ['ticket' => $t['ticket'], 'ws_url' => $ws, 'expires_at' => $t['expires_at'], 'mode' => 'account',
            'unix_user' => $t['unix_user'], 'session_uuid' => $t['session']->uuid]], 201)->header('Cache-Control', 'no-store');
    }
}
