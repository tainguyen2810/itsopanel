<?php

declare(strict_types=1);

namespace App\Infrastructure\Cloudflare;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;

/**
 * Client API Cloudflare v4 (D-70). Base URL cố định trong config, token Bearer chỉ nằm trong bộ nhớ của request;
 * thông báo lỗi không bao giờ chứa token.
 */
final class CloudflareClient
{
    public function __construct(private readonly string $token) {}

    /** Kiểm token còn hiệu lực; trả tên tài khoản Cloudflare (nếu token đọc được) làm nhãn. */
    public function verify(): ?string
    {
        $r = $this->call('get', '/user/tokens/verify');
        if (($r['status'] ?? null) !== 'active') {
            throw new CloudflareError(401, 'Token không còn hiệu lực.', false);
        }
        try {
            $acc = $this->call('get', '/accounts', ['per_page' => 1]);
        } catch (CloudflareError $e) {
            if ($e->retryable) {
                throw $e;
            }

            return null; // token chỉ có quyền DNS: không đọc được tên tài khoản
        }
        $name = is_array($acc) && is_array($acc[0] ?? null) ? ($acc[0]['name'] ?? null) : null;

        return is_string($name) ? mb_substr($name, 0, 100) : null;
    }

    public function zoneId(string $name): ?string
    {
        $r = $this->call('get', '/zones', ['name' => $name, 'per_page' => 1]);
        $id = is_array($r) && is_array($r[0] ?? null) ? ($r[0]['id'] ?? null) : null;

        return is_string($id) && preg_match('/^[a-f0-9]{32}$/', $id) === 1 ? $id : null;
    }

    /** @return list<array<string, mixed>> */
    public function records(string $zoneId): array
    {
        $out = [];
        for ($page = 1; $page <= 50; $page++) {
            $r = $this->call('get', "/zones/$zoneId/dns_records", ['per_page' => 100, 'page' => $page]);
            $rows = is_array($r) ? array_values(array_filter($r, 'is_array')) : [];
            array_push($out, ...$rows);
            if (count($rows) < 100) {
                break;
            }
        }

        return $out;
    }

    /**
     * @param  array<string, mixed>  $record  {type, name (FQDN), content, ttl, priority?, proxied?}
     * @return array<string, mixed>
     */
    public function create(string $zoneId, array $record): array
    {
        return (array) $this->call('post', "/zones/$zoneId/dns_records", $record);
    }

    /**
     * @param  array<string, mixed>  $record
     * @return array<string, mixed>
     */
    public function update(string $zoneId, string $id, array $record): array
    {
        return (array) $this->call('patch', "/zones/$zoneId/dns_records/$id", $record);
    }

    public function delete(string $zoneId, string $id): void
    {
        try {
            $this->call('delete', "/zones/$zoneId/dns_records/$id");
        } catch (CloudflareError $e) {
            if ($e->status !== 404) {
                throw $e; // 404: đã bị xóa phía Cloudflare
            }
        }
    }

    /**
     * @param  array<string, mixed>  $data
     * @return array<array-key, mixed>|null phần `result` của phản hồi
     */
    private function call(string $method, string $path, array $data = []): ?array
    {
        if (preg_match('#^/[a-z_/0-9]+$#', $path) !== 1) {
            throw new \InvalidArgumentException('Đường dẫn Cloudflare không hợp lệ.');
        }
        try {
            $res = $this->http()->{$method}($path, $data);
        } catch (ConnectionException $e) {
            throw new CloudflareError(0, 'Không kết nối được Cloudflare.', true);
        }
        $body = $res->json();
        if ($res->successful() && is_array($body) && ($body['success'] ?? false) === true) {
            $result = $body['result'] ?? null;

            return is_array($result) ? $result : null;
        }
        $msg = 'Cloudflare trả HTTP '.$res->status();
        if (is_array($body) && is_array($body['errors'] ?? null) && is_array($body['errors'][0] ?? null)) {
            $e = $body['errors'][0];
            $msg .= ': '.mb_substr((string) ($e['message'] ?? ''), 0, 300).(isset($e['code']) ? ' (mã '.(int) $e['code'].')' : '');
        }

        throw new CloudflareError($res->status(), str_replace($this->token, '***', $msg),
            $res->serverError() || $res->status() === 429);
    }

    private function http(): PendingRequest
    {
        return Http::baseUrl((string) config('itso.cloudflare.base_url'))->withToken($this->token)->acceptJson()->asJson()
            ->timeout((int) config('itso.cloudflare.timeout', 10))->connectTimeout(5)->withoutRedirecting();
    }
}
