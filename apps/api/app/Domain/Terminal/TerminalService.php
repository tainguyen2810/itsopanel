<?php

declare(strict_types=1);

namespace App\Domain\Terminal;

use App\Domain\Audit\AuditLogger;
use App\Domain\Data\DataSpec;
use App\Domain\Hosting\QuotaService;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentResult;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\HostingAccount;
use App\Models\Server;
use App\Models\TerminalRecording;
use App\Models\TerminalSession;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * Terminal USER (Prompt 6.4, D-75, ADR 0022): panel kiểm điều kiện (gói có SSH, account active, phạm vi, step-up ở
 * route), ghi terminal_sessions, xin agent ticket một lần 30 giây (pty.open). Ticket không ghi vào DB/audit/log.
 *
 * Terminal root (Prompt 7.5, ADR 0028): chỉ SUPER_ADMIN + step-up ≤ 10 phút (controller/route), agent chỉ mở khi policy
 * cục bộ root_terminal=true; phiên root luôn ghi asciicast ở agent, panel giữ metadata ở terminal_recordings và đọc
 * bản ghi theo trang bằng pty.recording.read. Dọn phiên theo pty.list.
 */
final class TerminalService
{
    /** Nhàn rỗi tối đa (giây) trước khi agent đóng phiên. */
    public const IDLE_SEC = 900;

    /** Thời gian sống tối đa của phiên ở agent (term.MaxLife). */
    public const MAX_HOURS = 12;

    /** Số byte tối đa mỗi trang bản ghi đọc từ agent. */
    public const RECORDING_PAGE = 262144;

    /** Phiên chưa ATTACH vẫn có trong pty.list; phiên mới hơn mốc này không bị dọn dù vắng mặt (ticket 30 s). */
    public const REAP_GRACE_SEC = 120;

    public function __construct(private readonly AgentClient $agent, private readonly QuotaService $quota, private readonly AuditLogger $audit) {}

    /** @return array{ticket: string, expires_at: string, unix_user: string, session: TerminalSession} */
    public function open(User $actor, HostingAccount $a, int $cols = 120, int $rows = 32): array
    {
        self::localOnly($a->server_id);
        if ($a->lifecycle_state !== 'active') {
            throw new ApiProblem(409, 'invalid_state_transition', 'Account không hoạt động', "Account đang {$a->lifecycle_state}: không mở terminal.");
        }
        if (! (bool) ($this->quota->limits($a)['ssh_allowed'] ?? false)) {
            throw new ApiProblem(409, 'package_limit_reached', 'Gói không có SSH', 'Gói hosting hiện tại không cho phép SSH/terminal.');
        }
        $s = TerminalSession::query()->create(['user_id' => $actor->id, 'server_id' => $a->server_id, 'hosting_account_id' => $a->id,
            'unix_uid' => $a->uid, 'mode' => 'account', 'started_at' => Carbon::now()]);
        try {
            $res = $this->agent->forServer($a->server_id)->call('pty.open', ['account' => DataSpec::acct($a), 'session_uuid' => $s->uuid, 'cols' => $cols,
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

    /**
     * Mở terminal root (ADR 0028). Người gọi đã là SUPER_ADMIN và vừa step-up; agent vẫn tự từ chối khi policy tắt.
     *
     * @return array{ticket: string, expires_at: string, unix_user: string, session: TerminalSession}
     */
    public function openRoot(User $actor, Server $server, string $clientIp, int $cols = 120, int $rows = 32): array
    {
        self::localOnly($server->id);
        $s = TerminalSession::query()->create(['user_id' => $actor->id, 'server_id' => $server->id, 'hosting_account_id' => null,
            'unix_uid' => 0, 'mode' => 'root', 'started_at' => Carbon::now()]);
        try {
            $res = $this->agent->forServer($server->id)->call('pty.open.root', ['session_uuid' => $s->uuid, 'cols' => $cols, 'rows' => $rows,
                'idle_timeout_sec' => self::IDLE_SEC], (string) Str::uuid7().':1:1',
                ['user_uuid' => $actor->uuid, 'role' => $actor->roleKey() ?? 'SYSTEM'], 15.0);
        } catch (AgentUnavailable $e) {
            $this->end($s, 'error');
            throw new ApiProblem(503, 'agent_unavailable', 'Agent không kết nối', mb_substr($e->getMessage(), 0, 200));
        }
        if (! $res->ok) {
            $this->end($s, 'error');
            $code = (string) ($res->error['code'] ?? 'internal');
            $msg = mb_substr((string) ($res->error['message'] ?? 'Lỗi agent.'), 0, 300);
            $this->audit->record('terminal.open', $server, ['session' => $s->uuid, 'mode' => 'root', 'client_ip' => $clientIp,
                'error' => $code], 'failure', $server->id, null, $actor);
            throw match ($code) {
                'op_disabled' => new ApiProblem(409, 'precondition_failed', 'Terminal root đang tắt',
                    'Máy chủ chưa bật terminal root. Quản trị viên máy chủ bật bằng lệnh "itso policy set terminal.root on" (không bật được từ panel).'),
                'quota_exceeded' => new ApiProblem(409, 'resource_locked', 'Đã mở đủ phiên', 'Mỗi máy chủ mở tối đa 2 phiên terminal root cùng lúc.'),
                'dependency_unavailable' => new ApiProblem(503, 'agent_unavailable', 'Terminal chưa sẵn sàng', $msg),
                default => new ApiProblem(503, 'agent_unavailable', 'Agent lỗi khi mở terminal', $msg),
            };
        }
        $data = (array) $res->data;
        $s->recording_ref = $s->uuid.'.cast';
        $s->save();
        TerminalRecording::query()->create(['terminal_session_id' => $s->id, 'mode' => 'root', 'client_ip' => $clientIp ?: null,
            'stored_ref' => $s->uuid.'.cast', 'bytes' => 0, 'width' => $cols, 'height' => $rows, 'truncated' => false, 'created_at' => Carbon::now()]);
        $this->audit->record('terminal.open', $server, ['session' => $s->uuid, 'mode' => 'root', 'unix_user' => 'root',
            'client_ip' => $clientIp, 'recording' => true], 'success', $server->id, null, $actor);

        return ['ticket' => (string) ($data['ticket'] ?? ''), 'expires_at' => Carbon::parse((string) ($data['expires_at'] ?? 'now'))->toIso8601String(),
            'unix_user' => 'root', 'session' => $s];
    }

    /**
     * Terminal đi qua socket stream của agent cục bộ + itso-gateway (D-75); kênh relay chưa mang stream (Phase 9)
     * nên server node từ xa chưa mở được terminal.
     */
    private static function localOnly(?int $serverId): void
    {
        if (AgentClient::isRemote($serverId)) {
            throw new ApiProblem(409, 'precondition_failed', 'Chưa hỗ trợ terminal trên node',
                'Terminal web hiện chỉ có trên máy panel; node từ xa dùng SSH/SFTP của account.');
        }
    }

    /** @return array<string, mixed> TerminalPolicy (không có server; controller thêm) */
    public function policy(): array
    {
        $res = $this->read('pty.policy', [], 10.0);

        return ['root_enabled' => (bool) ($res['root_enabled'] ?? false), 'record_root' => (bool) ($res['record_root'] ?? true),
            'record_user' => (bool) ($res['record_user'] ?? false), 'max_sessions_per_account' => (int) ($res['max_sessions_per_account'] ?? 2),
            'idle_timeout_sec' => (int) ($res['idle_timeout_sec'] ?? self::IDLE_SEC)];
    }

    /**
     * Một trang bản ghi (TerminalRecording). next_offset null khi đã hết và phiên đã đóng.
     *
     * @return array<string, mixed>
     */
    public function recording(TerminalSession $s, int $offset): array
    {
        $rec = $s->recording;
        if (! $rec instanceof TerminalRecording) {
            throw new ApiProblem(404, 'not_found', 'Phiên không có bản ghi', 'Phiên này không được ghi (policy record_user tắt).');
        }
        $res = $this->agent->forServer($s->server_id)->call('pty.recording.read', ['session_uuid' => $s->uuid, 'offset' => $offset, 'max_bytes' => self::RECORDING_PAGE],
            null, null, 30.0);
        if (! $res->ok) {
            $code = (string) ($res->error['code'] ?? 'internal');
            throw match ($code) {
                'not_found' => new ApiProblem(404, 'not_found', 'Không thấy bản ghi trên máy chủ', 'File bản ghi không còn trên máy chủ.'),
                'invalid_params' => ApiProblem::field('offset', mb_substr((string) ($res->error['message'] ?? 'offset không hợp lệ.'), 0, 200)),
                default => new ApiProblem(503, 'agent_unavailable', 'Agent lỗi khi đọc bản ghi', mb_substr((string) ($res->error['message'] ?? ''), 0, 200)),
            };
        }
        $d = (array) $res->data;
        $eof = (bool) ($d['eof'] ?? false);
        $next = (int) ($d['next_offset'] ?? 0);
        $truncated = (bool) ($d['truncated'] ?? false);
        if ($eof && ($rec->bytes !== $next || $rec->truncated !== $truncated)) {
            $rec->bytes = $next;
            $rec->truncated = $truncated;
            $rec->width = (int) ($d['width'] ?? $rec->width);
            $rec->height = (int) ($d['height'] ?? $rec->height);
            $rec->save();
        }
        $events = [];
        foreach ((array) ($d['events'] ?? []) as $e) {
            $e = (array) $e;
            $events[] = ['t' => (float) ($e['t'] ?? 0), 'data' => (string) ($e['data'] ?? '')];
        }

        return ['session_uuid' => $s->uuid, 'width' => (int) ($d['width'] ?? 80), 'height' => (int) ($d['height'] ?? 24),
            'events' => $events, 'next_offset' => $eof ? null : $next, 'truncated' => $truncated];
    }

    /**
     * Dọn phiên theo pty.list: phiên mở trong DB mà agent không còn giữ (và cũ hơn REAP_GRACE_SEC) → closed.
     * Agent không trả lời → quay về luật cũ (quá 12 giờ → expired). Trả số phiên đã đóng.
     */
    public function reap(): int
    {
        try {
            $res = $this->agent->call('pty.list', [], null, null, 10.0);
        } catch (AgentUnavailable) {
            $res = null;
        }
        if (! $res instanceof AgentResult || ! $res->ok) {
            return TerminalSession::query()->whereNull('ended_at')->where('started_at', '<', Carbon::now()->subHours(self::MAX_HOURS))
                ->update(['ended_at' => Carbon::now(), 'ended_reason' => 'expired']);
        }
        $live = [];
        foreach ((array) (((array) $res->data)['sessions'] ?? []) as $row) {
            $row = (array) $row;
            $live[(string) ($row['session_uuid'] ?? '')] = $row;
        }
        $n = 0;
        TerminalSession::query()->whereNull('ended_at')->orderBy('id')->each(function (TerminalSession $s) use ($live, &$n): void {
            $row = $live[$s->uuid] ?? null;
            if ($row === null) {
                if ($s->started_at->lt(Carbon::now()->subSeconds(self::REAP_GRACE_SEC))) {
                    $this->end($s, 'closed');
                    $n++;
                }

                return;
            }
            if ((bool) ($row['recording'] ?? false)) { // phiên account được ghi theo policy record_user
                $rec = TerminalRecording::query()->firstOrCreate(['terminal_session_id' => $s->id], ['mode' => $s->mode,
                    'stored_ref' => $s->uuid.'.cast', 'bytes' => 0, 'truncated' => false, 'created_at' => Carbon::now()]);
                $rec->bytes = (int) ($row['recording_bytes'] ?? $rec->bytes);
                $rec->save();
                if ($s->recording_ref === null) {
                    $s->recording_ref = $s->uuid.'.cast';
                    $s->save();
                }
            }
        });

        return $n;
    }

    /** @param  array<string, mixed>  $params
     * @return array<string, mixed> */
    private function read(string $op, array $params, float $timeout): array
    {
        try {
            $res = $this->agent->call($op, $params, null, null, $timeout);
        } catch (AgentUnavailable $e) {
            throw new ApiProblem(503, 'agent_unavailable', 'Agent không kết nối', mb_substr($e->getMessage(), 0, 200));
        }
        if (! $res->ok) {
            throw new ApiProblem(503, 'agent_unavailable', 'Agent lỗi', mb_substr((string) ($res->error['message'] ?? ''), 0, 200));
        }

        return (array) $res->data;
    }

    private function end(TerminalSession $s, string $reason): void
    {
        $s->ended_at = Carbon::now();
        $s->ended_reason = $reason;
        $s->save();
    }
}
