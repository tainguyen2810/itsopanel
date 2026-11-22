<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use App\Domain\Notifications\Notifier;
use App\Http\Presenters\ServerPresenter;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Infrastructure\Agent\RelayClient;
use App\Jobs\RunJob;
use App\Models\Agent;
use App\Models\AgentCertificate;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Log;

/**
 * Đồng bộ với itso-relay mỗi phút (D-91, ADR 0037): last_seen của node từ GET /v1/status, trạng thái kết nối
 * online/degraded/unreachable + thông báo SUPER_ADMIN, chạy tiếp job waiting_agent khi node quay lại hoặc hết hạn,
 * đẩy lại danh sách thu hồi (relay khởi động lại vẫn chặn đúng).
 */
final class RelaySync
{
    public function __construct(private readonly RelayClient $relay, private readonly Notifier $notifier) {}

    /** @return list<string> */
    public static function revokedFingerprints(): array
    {
        return array_values(array_map('strval', AgentCertificate::query()->whereNotNull('revoked_at')
            ->where('not_after', '>', Carbon::now())->orderBy('id')->pluck('fingerprint_sha256')->all()));
    }

    public static function pushRevocations(RelayClient $relay): bool
    {
        try {
            $relay->putRevocations(self::revokedFingerprints());

            return true;
        } catch (AgentUnavailable $e) {
            Log::warning('Không đẩy được danh sách thu hồi tới itso-relay (sẽ thử lại ở itso:relay-sync): '.$e->getMessage());

            return false;
        }
    }

    /** @return array{nodes: int, online: int, changed: int, resumed: int, relay: bool} */
    public function sync(): array
    {
        $out = ['nodes' => 0, 'online' => 0, 'changed' => 0, 'resumed' => 0, 'relay' => false];
        $agents = Agent::query()->where('transport', 'mtls')->whereNull('revoked_at')->get();
        $out['nodes'] = $agents->count();
        $status = [];
        if ($agents->isNotEmpty() || AgentCertificate::query()->whereNotNull('revoked_at')->exists()) {
            try {
                $status = $this->relay->status();
                $out['relay'] = true;
                self::pushRevocations($this->relay);
            } catch (AgentUnavailable $e) {
                Log::warning('itso-relay không trả lời: '.$e->getMessage());
            }
        }
        $online = [];
        foreach ($agents as $agent) {
            $server = Server::query()->find($agent->server_id);
            if (! $server instanceof Server) {
                continue;
            }
            $st = $status[$server->uuid] ?? null;
            $connected = $st !== null && $st['connected'] && $st['fingerprint_sha256'] === $agent->cert_fingerprint;
            if ($connected) {
                $seen = $st['last_seen'] !== '' ? Carbon::parse($st['last_seen']) : Carbon::now();
                if ($agent->last_seen_at === null || $seen->gt($agent->last_seen_at)) {
                    $agent->last_seen_at = $seen;
                }
            }
            $old = $agent->connection;
            $new = ServerPresenter::connection($agent);
            if ($old !== $new) {
                $agent->connection = $new;
                $out['changed']++;
                $this->notifyChange($server, $old, $new);
            }
            $agent->save();
            if ($new === 'online') {
                $out['online']++;
                // Chỉ chạy tiếp job chờ khi relay xác nhận node đang nối (relay không trả lời thì dựa vào heartbeat).
                if ($connected || ! $out['relay']) {
                    $online[] = $server->id;
                }
            }
        }
        // Job chờ node: chạy tiếp khi node online, hoặc khi đã quá hạn (JobRunner đánh failed agent_unreachable).
        Job::query()->where('state', 'waiting_agent')
            ->where(fn ($q) => $q->whereIn('server_id', $online)->orWhere('agent_deadline_at', '<', Carbon::now()))
            ->orderBy('id')->pluck('id')->each(function (int $id) use (&$out): void {
                RunJob::dispatch($id);
                $out['resumed']++;
            });

        return $out;
    }

    private function notifyChange(Server $s, string $old, string $new): void
    {
        $msg = match (true) {
            $new === 'unreachable' => ['server.unreachable', "{$s->name} mất kết nối", 'Node không gửi heartbeat quá 5 phút; job mới chờ node quay lại (tối đa 30 phút).', 'high'],
            $new === 'online' && in_array($old, ['unreachable', 'degraded'], true) => ['server.reconnected', "{$s->name} đã kết nối lại", 'Các job đang chờ node được chạy tiếp.', 'info'],
            $new === 'online' && $old === 'pending' => ['server.joined', "{$s->name} đã kết nối lần đầu", 'Node đã join và kết nối tới itso-relay.', 'info'],
            default => null,
        };
        if ($msg === null) {
            return;
        }
        User::query()->where('realm', 'admin')->where('status', 'active')
            ->whereHas('roles', fn ($q) => $q->where('key', 'SUPER_ADMIN'))->get()
            ->each(fn (User $u) => $this->notifier->notify($u, $msg[0], $msg[1], $msg[2], $msg[3], '/servers/'.$s->uuid));
    }
}
