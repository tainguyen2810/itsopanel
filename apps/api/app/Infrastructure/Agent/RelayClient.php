<?php

declare(strict_types=1);

namespace App\Infrastructure\Agent;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Factory as Http;
use Illuminate\Http\Client\PendingRequest;

/**
 * Điều khiển itso-relay qua unix socket (ADR 0035): trạng thái node đang kết nối và danh sách thu hồi.
 * Envelope op đi qua AgentClient::forServer, không qua lớp này.
 */
final class RelayClient
{
    public function __construct(private readonly Http $http) {}

    private function req(): PendingRequest
    {
        $sock = config('itso.relay.socket');
        if (! is_string($sock) || $sock === '') {
            throw new AgentUnavailable('Chưa cấu hình ITSO_RELAY_SOCKET.');
        }

        return $this->http->withOptions(['curl' => [CURLOPT_UNIX_SOCKET_PATH => $sock], 'timeout' => 5, 'connect_timeout' => 2])
            ->acceptJson();
    }

    /**
     * @return array<string, array{connected: bool, last_seen: string, fingerprint_sha256: string, cert_not_after: string}> theo server_uuid
     */
    public function status(): array
    {
        try {
            $res = $this->req()->get('http://relay/v1/status');
        } catch (ConnectionException $e) {
            throw new AgentUnavailable('Không kết nối được itso-relay: '.$e->getMessage(), 0, $e);
        }
        if (! $res->successful() || ! is_array($res->json('nodes'))) {
            throw new AgentUnavailable('itso-relay trả dữ liệu không hợp lệ (HTTP '.$res->status().').');
        }
        $out = [];
        foreach ((array) $res->json('nodes') as $n) {
            if (is_array($n) && is_string($n['server_uuid'] ?? null)) {
                $out[$n['server_uuid']] = ['connected' => ($n['connected'] ?? false) === true,
                    'last_seen' => (string) ($n['last_seen'] ?? ''), 'fingerprint_sha256' => (string) ($n['fingerprint_sha256'] ?? ''),
                    'cert_not_after' => (string) ($n['cert_not_after'] ?? '')];
            }
        }

        return $out;
    }

    /** @param  list<string>  $fingerprints */
    public function putRevocations(array $fingerprints): void
    {
        try {
            $res = $this->req()->put('http://relay/v1/revocations', ['fingerprints' => $fingerprints]);
        } catch (ConnectionException $e) {
            throw new AgentUnavailable('Không kết nối được itso-relay: '.$e->getMessage(), 0, $e);
        }
        if (! $res->successful()) {
            throw new AgentUnavailable('itso-relay từ chối danh sách thu hồi (HTTP '.$res->status().').');
        }
    }
}
