<?php

declare(strict_types=1);

namespace App\Infrastructure\Agent;

use App\Models\Agent;
use App\Models\Server;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Factory as Http;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Str;

/**
 * Client gửi typed operation tới Go agent qua HTTP JSON trên unix socket (Linux)
 * hoặc 127.0.0.1 (Windows dev). Không chạy lệnh hệ thống: chỉ là HTTP request.
 *
 * Phase 1 chỉ dùng system.ping cho trang trạng thái. Từ Phase 3 worker gọi qua đây
 * với op_id = job_uuid:seq:attempt.
 *
 * Phase 9 (D-89, ADR 0035): `forServer()` chọn kênh theo agents.transport. `local` giữ socket agent cục bộ;
 * `mtls` gửi envelope (ký bằng khóa HMAC riêng của node) tới unix socket của itso-relay, đường
 * /v1/nodes/{server_uuid}/ops. Relay chỉ chuyển nguyên byte; chữ ký vẫn tính trên đường /v1/ops mà agent kiểm.
 */
final class AgentClient
{
    public function __construct(
        private readonly Http $http,
        private readonly ?string $socket,
        private readonly ?string $url,
        private readonly float $timeout = 5.0,
        private readonly ?string $keyFile = null,
        private readonly ?string $relaySocket = null,
        private readonly ?string $nodeUuid = null,
        private readonly ?string $nodeKey = null,
    ) {}

    /**
     * Client cho server cụ thể. null hoặc server có agent local → chính client này (socket agent cục bộ).
     */
    public function forServer(?int $serverId): self
    {
        if ($serverId === null) {
            return $this;
        }
        /** @var Agent|null $agent */
        $agent = Agent::query()->where('server_id', $serverId)->first();
        if ($agent === null || $agent->transport !== 'mtls') {
            return $this;
        }
        if ($agent->connection === 'revoked' || $agent->revoked_at !== null) {
            throw new AgentUnavailable('Node đã bị thu hồi.');
        }
        /** @var Server $server */
        $server = Server::query()->findOrFail($serverId);

        return new self($this->http, $this->socket, $this->url, $this->timeout, $this->keyFile, $this->relaySocket,
            $server->uuid, self::decryptKey($agent));
    }

    /** Khóa HMAC riêng của node: cột bytea chứa chuỗi Crypt (APP_KEY). */
    public static function decryptKey(Agent $agent): string
    {
        $raw = $agent->getRawOriginal('hmac_key_encrypted');
        if (is_resource($raw)) {
            $raw = stream_get_contents($raw);
        }
        if (! is_string($raw) || $raw === '') {
            throw new AgentUnavailable('Node chưa có khóa HMAC (chưa enroll xong).');
        }
        $key = Crypt::decryptString($raw);
        if (strlen($key) < 32) {
            throw new AgentUnavailable('Khóa HMAC của node quá ngắn.');
        }

        return $key;
    }

    /** Mã hóa khóa HMAC để lưu vào agents.hmac_key_encrypted. */
    public static function encryptKey(string $key): string
    {
        return Crypt::encryptString($key);
    }

    /** Header chữ ký HMAC-SHA256 (D-66) trên v1\n{method}\n{path}\n{ts}\n{nonce}\n{sha256(body)}. */
    public static function signature(string $key, string $method, string $path, int $ts, string $nonce, string $body): string
    {
        $canonical = implode("\n", ['v1', $method, $path, (string) $ts, $nonce, hash('sha256', $body)]);

        return hash_hmac('sha256', $canonical, $key);
    }

    private function key(): ?string
    {
        if ($this->keyFile === null) {
            return null;
        }
        $raw = @file_get_contents($this->keyFile);
        if ($raw === false || strlen(trim($raw)) < 32) {
            throw new AgentUnavailable('Không đọc được khóa agent (ITSO_AGENT_KEY_FILE) hoặc khóa quá ngắn.');
        }

        return trim($raw);
    }

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
        $path = '/v1/ops';
        if ($this->nodeUuid !== null) {
            if ($this->relaySocket === null || $this->relaySocket === '') {
                throw new AgentUnavailable('Chưa cấu hình ITSO_RELAY_SOCKET cho node từ xa.');
            }
            $options['curl'] = [CURLOPT_UNIX_SOCKET_PATH => $this->relaySocket];
            $base = 'http://relay';
            $path = '/v1/nodes/'.$this->nodeUuid.'/ops';
        } elseif ($this->socket !== null && $this->socket !== '') {
            $options['curl'] = [CURLOPT_UNIX_SOCKET_PATH => $this->socket];
            $base = 'http://agent';
        } elseif ($this->url !== null && $this->url !== '') {
            $base = rtrim($this->url, '/');
        } else {
            throw new AgentUnavailable('Chưa cấu hình ITSO_AGENT_SOCKET hoặc ITSO_AGENT_URL.');
        }

        $body = json_encode($envelope, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $headers = [];
        $key = $this->nodeKey ?? $this->key();
        if ($key !== null) {
            $headers = [
                'X-ITSO-Timestamp' => (string) $now,
                'X-ITSO-Nonce' => $envelope['nonce'],
                'X-ITSO-Signature' => self::signature($key, 'POST', '/v1/ops', $now, $envelope['nonce'], $body),
            ];
        }

        try {
            $response = $this->http->withOptions($options)->acceptJson()->withHeaders($headers)
                ->withBody($body, 'application/json')->post($base.$path);
        } catch (ConnectionException $e) {
            if ($this->nodeUuid !== null) {
                throw new AgentUnreachable('Không kết nối được itso-relay: '.$e->getMessage(), 0, $e);
            }
            throw new AgentUnavailable('Không kết nối được agent: '.$e->getMessage(), 0, $e);
        }
        $res = $response->json();
        if ($this->nodeUuid !== null && in_array($response->status(), [503, 504], true)) {
            throw new AgentUnreachable('Node không kết nối với relay ('.(is_array($res) ? (string) ($res['code'] ?? '') : '').').');
        }
        if (! $response->successful() || ! is_array($res) || ! isset($res['ok'], $res['op_id'])) {
            throw new AgentUnavailable('Agent trả về dữ liệu không hợp lệ (HTTP '.$response->status().').');
        }

        /** @var array{code: string, message: string, retryable: bool}|null $error */
        $error = is_array($res['error'] ?? null) ? $res['error'] : null;

        return new AgentResult(
            opId: (string) $res['op_id'],
            ok: $res['ok'] === true,
            data: is_array($res['data'] ?? null) ? $res['data'] : null,
            error: $error,
            durationMs: (int) ($res['duration_ms'] ?? 0),
            agentVersion: (string) ($res['agent_version'] ?? ''),
            cached: ($res['cached'] ?? false) === true,
        );
    }
}
