<?php

declare(strict_types=1);

namespace App\Infrastructure\Agent;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Factory as Http;
use Illuminate\Support\Str;

/**
 * Client gửi typed operation tới Go agent qua HTTP JSON trên unix socket (Linux)
 * hoặc 127.0.0.1 (Windows dev). Không chạy lệnh hệ thống: chỉ là HTTP request.
 *
 * Phase 1 chỉ dùng system.ping cho trang trạng thái. Từ Phase 3 worker gọi qua đây
 * với op_id = job_uuid:seq:attempt.
 */
final class AgentClient
{
    public function __construct(
        private readonly Http $http,
        private readonly ?string $socket,
        private readonly ?string $url,
        private readonly float $timeout = 5.0,
    ) {}

    /**
     * @param  array<string, mixed>  $params
     * @param  array{user_uuid: string|null, role: string}|null  $requestedBy  chỉ dùng cho audit phía agent
     * @param  float|null  $timeout  giây; mặc định ITSO_AGENT_TIMEOUT (job truyền thời gian còn lại của job)
     */
    public function call(string $op, array $params = [], ?string $opId = null, ?array $requestedBy = null,
        ?float $timeout = null): AgentResult
    {
        $now = time();
        $timeout = $timeout !== null ? max(1.0, $timeout) : $this->timeout;
        $envelope = [
            'v' => 1,
            'op' => $op,
            'op_id' => $opId ?? Str::uuid()->toString().':1:1',
            'params' => (object) $params,
            'deadline' => gmdate('Y-m-d\TH:i:s\Z', $now + (int) ceil($timeout)),
            'ts' => $now,
            'nonce' => Str::random(24),
            'requested_by' => $requestedBy ?? ['user_uuid' => null, 'role' => 'SYSTEM'],
        ];

        $options = ['timeout' => $timeout, 'connect_timeout' => min(2.0, $timeout)];
        if ($this->socket !== null && $this->socket !== '') {
            $options['curl'] = [CURLOPT_UNIX_SOCKET_PATH => $this->socket];
            $base = 'http://agent';
        } elseif ($this->url !== null && $this->url !== '') {
            $base = rtrim($this->url, '/');
        } else {
            throw new AgentUnavailable('Chưa cấu hình ITSO_AGENT_SOCKET hoặc ITSO_AGENT_URL.');
        }

        try {
            $response = $this->http->withOptions($options)->acceptJson()->asJson()
                ->post($base.'/v1/ops', $envelope);
        } catch (ConnectionException $e) {
            throw new AgentUnavailable('Không kết nối được agent: '.$e->getMessage(), 0, $e);
        }
        $body = $response->json();
        if (! $response->successful() || ! is_array($body) || ! isset($body['ok'], $body['op_id'])) {
            throw new AgentUnavailable('Agent trả về dữ liệu không hợp lệ (HTTP '.$response->status().').');
        }

        /** @var array{code: string, message: string, retryable: bool}|null $error */
        $error = is_array($body['error'] ?? null) ? $body['error'] : null;

        return new AgentResult(
            opId: (string) $body['op_id'],
            ok: $body['ok'] === true,
            data: is_array($body['data'] ?? null) ? $body['data'] : null,
            error: $error,
            durationMs: (int) ($body['duration_ms'] ?? 0),
            agentVersion: (string) ($body['agent_version'] ?? ''),
            cached: ($body['cached'] ?? false) === true,
        );
    }
}
