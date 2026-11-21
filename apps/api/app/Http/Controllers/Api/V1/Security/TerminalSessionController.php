<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Security;

use App\Auth\Access;
use App\Domain\Audit\AuditLogger;
use App\Domain\Terminal\TerminalService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\HostingPresenter;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\TerminalSession;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Terminal (Prompt 7.5, ADR 0028): policy đọc từ agent (chỉ đọc), danh sách phiên theo phạm vi (phiên root chỉ
 * SUPER_ADMIN thấy), bản ghi asciicast theo trang (SUPER_ADMIN + step-up ở route).
 */
final class TerminalSessionController extends SecurityBase
{
    public function __construct(Access $access, JobPresenter $jobs, private readonly TerminalService $terminal)
    {
        parent::__construct($access, $jobs);
    }

    public function policy(Request $request, string $id): JsonResponse
    {
        $s = $this->server($request, $id);

        return response()->json(['data' => ['server' => ['uuid' => $s->uuid, 'name' => $s->name]] + $this->terminal->policy()]);
    }

    public function index(Request $request): JsonResponse
    {
        $q = $this->visible($request)->with(['server', 'user', 'hostingAccount', 'recording'])
            ->whereIn('server_id', $this->servers($request)->select('servers.id'));

        return response()->json(Listing::page($request, $q, ['started_at' => 'terminal_sessions.started_at'], '-started_at',
            fn (TerminalSession $s): array => self::present($s)));
    }

    public function recording(Request $request, string $id, AuditLogger $audit): JsonResponse
    {
        $s = Str::isUuid($id) ? $this->visible($request)->where('uuid', $id)->first() : null;
        if (! $s instanceof TerminalSession) {
            throw new NotFoundHttpException;
        }
        $offset = $request->query('offset', '0');
        if (! is_string($offset) || ! ctype_digit($offset) || strlen($offset) > 15) {
            throw ApiProblem::field('offset', 'offset phải là số nguyên ≥ 0.');
        }
        $data = $this->terminal->recording($s, (int) $offset);
        if ((int) $offset === 0) { // ghi một lần mỗi lượt xem, không ghi từng trang
            $audit->record('terminal.recording_view', $s, ['session' => $s->uuid, 'mode' => $s->mode, 'client_ip' => $this->clientIp($request)],
                'success', $s->server_id, null, $this->actor($request));
        }

        return response()->json(['data' => $data])->header('Cache-Control', 'no-store');
    }

    /** @return Builder<TerminalSession> phiên root chỉ SUPER_ADMIN thấy */
    private function visible(Request $request): Builder
    {
        $q = TerminalSession::query()->whereIn('server_id', $this->access->servers($this->actor($request))->select('servers.id'));
        if ($this->actor($request)->roleKey() !== 'SUPER_ADMIN') {
            $q->where('mode', 'account')
                ->whereIn('hosting_account_id', $this->access->accounts($this->actor($request))->select('hosting_accounts.id'));
        }

        return $q;
    }

    /** @return array<string, mixed> TerminalSession */
    private static function present(TerminalSession $s): array
    {
        $a = $s->hostingAccount;
        $rec = $s->recording;
        $reason = match ($s->ended_reason) {
            null => null,
            'exit', 'idle', 'closed', 'killed', 'expired', 'limit' => $s->ended_reason,
            default => 'killed', // 'error': phiên không mở được
        };

        return ['uuid' => $s->uuid, 'mode' => $s->mode, 'unix_user' => $s->mode === 'root' ? 'root' : (string) ($a->username ?? ''),
            'server' => $s->server !== null ? ['uuid' => $s->server->uuid, 'name' => $s->server->name] : ['uuid' => '00000000-0000-4000-8000-000000000000', 'name' => '-'],
            'hosting_account' => $a !== null ? ['uuid' => $a->uuid, 'username' => $a->username] : null,
            'opened_by' => HostingPresenter::userRef($s->user), 'client_ip' => $rec?->client_ip,
            'started_at' => $s->started_at->toIso8601String(), 'ended_at' => $s->ended_at?->toIso8601String(), 'ended_reason' => $reason,
            'recorded' => $rec !== null, 'recording_bytes' => (int) ($rec->bytes ?? 0)];
    }
}
