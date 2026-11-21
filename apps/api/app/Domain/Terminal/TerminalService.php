<?php

declare(strict_types=1);

namespace App\Domain\Terminal;

use App\Domain\Audit\AuditLogger;
use App\Domain\Data\DataSpec;
use App\Domain\Hosting\QuotaService;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\HostingAccount;
use App\Models\TerminalSession;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * Terminal USER (Prompt 6.4, D-75, ADR 0022): panel kiểm điều kiện (gói có SSH, account active, phạm vi, step-up ở
 * route), ghi terminal_sessions, xin agent ticket một lần 30 giây (pty.open). Ticket không ghi vào DB/audit/log.
 */
final class TerminalService
{
    /** Nhàn rỗi tối đa (giây) trước khi agent đóng phiên. */
    public const IDLE_SEC = 900;

    /** Thời gian sống tối đa của phiên ở agent (term.MaxLife). */
    public const MAX_HOURS = 12;

    public function __construct(private readonly AgentClient $agent, private readonly QuotaService $quota, private readonly AuditLogger $audit) {}

    /** @return array{ticket: string, expires_at: string, unix_user: string, session: TerminalSession} */
    public function open(User $actor, HostingAccount $a, int $cols = 120, int $rows = 32): array
    {
        if ($a->lifecycle_state !== 'active') {
            throw new ApiProblem(409, 'invalid_state_transition', 'Account không hoạt động', "Account đang {$a->lifecycle_state}: không mở terminal.");
        }
        if (! (bool) ($this->quota->limits($a)['ssh_allowed'] ?? false)) {
            throw new ApiProblem(409, 'package_limit_reached', 'Gói không có SSH', 'Gói hosting hiện tại không cho phép SSH/terminal.');
        }
        $s = TerminalSession::query()->create(['user_id' => $actor->id, 'server_id' => $a->server_id, 'hosting_account_id' => $a->id,
            'unix_uid' => $a->uid, 'mode' => 'account', 'started_at' => Carbon::now()]);
        try {
            $res = $this->agent->call('pty.open', ['account' => DataSpec::acct($a), 'session_uuid' => $s->uuid, 'cols' => $cols,
                'rows' => $rows, 'idle_timeout_sec' => self::IDLE_SEC], (string) Str::uuid7().':1:1',
                ['user_uuid' => $actor->uuid, 'role' => $actor->roleKey() ?? 'SYSTEM'], 15.0);
        } catch (AgentUnavailable $e) {
            $this->end($s, 'error');
            throw new ApiProblem(503, 'agent_unavailable', 'Agent không kết nối', mb_substr($e->getMessage(), 0, 200));
        }
        if (! $res->ok) {
            $this->end($s, 'error');
            $code = (string) ($res->error['code'] ?? 'internal');
            $msg = mb_substr((string) ($res->error['message'] ?? 'Lỗi agent.'), 0, 300);
            throw match ($code) {
                'quota_exceeded' => new ApiProblem(409, 'resource_locked', 'Đã mở đủ phiên', 'Mỗi account mở tối đa 2 phiên terminal cùng lúc.'),
                'precondition_failed', 'not_found' => new ApiProblem(409, 'conflict', 'Không mở được terminal', $msg),
                'dependency_unavailable' => new ApiProblem(503, 'agent_unavailable', 'Terminal chưa sẵn sàng', $msg),
                default => new ApiProblem(503, 'agent_unavailable', 'Agent lỗi khi mở terminal', $msg),
            };
        }
        $data = (array) $res->data;
        $this->audit->record('terminal.open', $a, ['session' => $s->uuid, 'mode' => 'account', 'unix_user' => $a->username],
            'success', $a->server_id, null, $actor);

        return ['ticket' => (string) ($data['ticket'] ?? ''), 'expires_at' => Carbon::parse((string) ($data['expires_at'] ?? 'now'))->toIso8601String(),
            'unix_user' => (string) ($data['unix_user'] ?? $a->username), 'session' => $s];
    }

    /** Đóng bản ghi phiên đã quá thời gian sống tối đa ở agent. Trả số phiên đã đóng. */
    public function reap(): int
    {
        return TerminalSession::query()->whereNull('ended_at')->where('started_at', '<', Carbon::now()->subHours(self::MAX_HOURS))
            ->update(['ended_at' => Carbon::now(), 'ended_reason' => 'expired']);
    }

    private function end(TerminalSession $s, string $reason): void
    {
        $s->ended_at = Carbon::now();
        $s->ended_reason = $reason;
        $s->save();
    }
}
