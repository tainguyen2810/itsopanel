<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use App\Domain\Audit\AuditLogger;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\Agent;
use App\Models\AgentCertificate;
use App\Models\AgentEnrollmentToken;
use App\Models\Server;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Join node (D-90, ADR 0036): token một lần (DB chỉ lưu sha256), enroll qua itso-relay (chữ ký relay), CSR ký bằng
 * pki.sign_csr trên agent local, khóa HMAC riêng của node mã hóa APP_KEY và chỉ trả một lần.
 */
final class NodeEnrollment
{
    public const CERT_TTL_DAYS = 30;

    public function __construct(private readonly AgentClient $agent, private readonly AuditLogger $audit) {}

    public static function caPem(): ?string
    {
        $f = config('itso.pki.ca_file');
        $pem = is_string($f) && $f !== '' ? @file_get_contents($f) : false;

        return is_string($pem) && str_contains($pem, 'BEGIN CERTIFICATE') ? $pem : null;
    }

    /** sha256 của chứng chỉ CA (DER, hex) — giá trị `--ca-sha256`. */
    public static function caPin(): ?string
    {
        $pem = self::caPem();
        if ($pem === null || preg_match('/-----BEGIN CERTIFICATE-----(.+?)-----END CERTIFICATE-----/s', $pem, $m) !== 1) {
            return null;
        }
        $der = base64_decode(preg_replace('/\s+/', '', $m[1]) ?? '', true);

        return $der === false ? null : hash('sha256', $der);
    }

    public static function relayUrl(Request $request): string
    {
        $u = config('itso.relay.public_url');

        return is_string($u) && $u !== '' ? rtrim($u, '/') : 'https://'.$request->getHost().':28444';
    }

    /** 32 byte ngẫu nhiên, base64url không đệm (43 ký tự). */
    private static function b64url32(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    /**
     * @param  list<string>  $roleTags
     * @return array{uuid: string, token: string, command: string, ca_sha256: string, expires_at: string, created_at: string}
     */
    public function createToken(User $actor, string $name, array $roleTags, int $ttlMin, string $relayUrl): array
    {
        $pin = self::caPin();
        if ($pin === null) {
            throw new ApiProblem(409, 'precondition_failed', 'Chưa có CA nội bộ',
                'Máy panel chưa có CA nội bộ: chạy "sudo itso pki init" rồi bật itso-relay (docs/runbooks/multi-server.md).');
        }
        if (Server::query()->withTrashed()->where('name', $name)->exists()) {
            throw ApiProblem::conflict('Tên server đã được dùng.');
        }
        $token = 'itso_enr_'.self::b64url32();
        $t = AgentEnrollmentToken::query()->create(['token_hash' => hash('sha256', $token), 'server_name' => $name,
            'role_tags' => $roleTags, 'created_by_user_id' => $actor->id,
            'expires_at' => Carbon::now()->addMinutes($ttlMin)]);
        $t->refresh();
        $this->audit->record('server.enroll', $t, ['server_name' => $name, 'role_tags' => $roleTags,
            'ttl_min' => $ttlMin]);
        $install = config('itso.pki.install_url');
        $cmd = (is_string($install) && $install !== '' ? 'curl -fsSLO '.$install.' && ' : '')
            ."sudo bash install.sh --role node --join {$relayUrl} --token {$token} --ca-sha256 {$pin}";

        return ['uuid' => $t->uuid, 'token' => $token, 'command' => $cmd, 'ca_sha256' => $pin,
            'expires_at' => $t->expires_at->toIso8601String(), 'created_at' => $t->created_at->toIso8601String()];
    }

    /** Kiểm chữ ký relay: hex(HMAC-SHA256(khóa, "relay-enroll\n" + ts + "\n" + hex(sha256(body)))), lệch ≤ 300 giây. */
    public static function verifyRelay(Request $request): void
    {
        $file = config('itso.relay.enroll_key_file');
        $key = is_string($file) && $file !== '' ? @file_get_contents($file) : false;
        $key = is_string($key) ? trim($key) : '';
        $ts = (string) $request->header('X-Itso-Relay-Timestamp', '');
        $sig = (string) $request->header('X-Itso-Relay-Signature', '');
        if (strlen($key) < 32 || preg_match('/^\d{1,12}$/', $ts) !== 1 || abs(time() - (int) $ts) > 300) {
            throw new ApiProblem(401, 'unauthenticated', 'Yêu cầu không đến từ itso-relay', 'Thiếu hoặc sai chữ ký relay.');
        }
        $want = hash_hmac('sha256', "relay-enroll\n{$ts}\n".hash('sha256', $request->getContent()), $key);
        if (! hash_equals($want, $sig)) {
            throw new ApiProblem(401, 'unauthenticated', 'Yêu cầu không đến từ itso-relay', 'Thiếu hoặc sai chữ ký relay.');
        }
    }

    private static function invalid(string $detail): ApiProblem
    {
        return new ApiProblem(422, 'enrollment_invalid', 'Không join được', $detail);
    }

    /**
     * @param  array{token: string, csr: string, hostname: string, ip_addresses?: list<string>, facts?: array<string, mixed>}  $in
     * @return array<string, mixed> NodeEnrollment
     */
    public function enroll(array $in, string $clientIp, string $relayUrl): array
    {
        return DB::transaction(function () use ($in, $clientIp, $relayUrl): array {
            /** @var AgentEnrollmentToken|null $tok */
            $tok = AgentEnrollmentToken::query()->where('token_hash', hash('sha256', $in['token']))->lockForUpdate()->first();
            if ($tok === null || $tok->used_at !== null || $tok->expires_at->isPast()) {
                throw self::invalid('Token sai, đã dùng hoặc hết hạn: tạo token mới trong panel.');
            }
            if (Server::query()->withTrashed()->where('name', $tok->server_name)->exists()) {
                throw self::invalid('Tên server của token đã được dùng.');
            }
            $facts = (array) ($in['facts'] ?? []);
            $ips = array_values(array_filter((array) ($in['ip_addresses'] ?? []), fn ($ip): bool => filter_var($ip, FILTER_VALIDATE_IP) !== false));
            $server = Server::query()->create(['name' => $tok->server_name, 'hostname' => $in['hostname'], 'ip_addresses' => $ips,
                'role_tags' => $tok->role_tags, 'node_role' => 'node', 'status' => 'pending',
                'os' => is_string($facts['os'] ?? null) ? $facts['os'] : null,
                'kernel' => is_string($facts['kernel'] ?? null) ? $facts['kernel'] : null]);
            $server->refresh();
            try {
                $res = $this->agent->forServer(null)->call('pki.sign_csr', ['server_uuid' => $server->uuid, 'csr' => $in['csr'],
                    'ttl_days' => self::CERT_TTL_DAYS], (string) Str::uuid7().':1:1', ['user_uuid' => null, 'role' => 'SYSTEM'], 30.0);
            } catch (AgentUnavailable $e) {
                throw new ApiProblem(503, 'agent_unavailable', 'Agent máy panel không trả lời', mb_substr($e->getMessage(), 0, 200));
            }
            if (! $res->ok || ! is_array($res->data)) {
                throw self::invalid('CSR bị từ chối: '.(string) ($res->error['message'] ?? ''));
            }
            $d = $res->data;
            $hmac = self::b64url32();
            $agent = Agent::query()->create(['server_id' => $server->id, 'transport' => 'mtls', 'connection' => 'pending',
                'version' => is_string($facts['agent_version'] ?? null) ? $facts['agent_version'] : null,
                'cert_fingerprint' => (string) $d['fingerprint_sha256'], 'cert_not_before' => Carbon::parse((string) $d['not_before']),
                'cert_expires_at' => Carbon::parse((string) $d['not_after'])]);
            DB::table('agents')->where('id', $agent->id)->update(['hmac_key_encrypted' => AgentClient::encryptKey($hmac)]);
            AgentCertificate::query()->create(['server_id' => $server->id, 'serial' => (string) $d['serial'],
                'fingerprint_sha256' => (string) $d['fingerprint_sha256'], 'not_before' => Carbon::parse((string) $d['not_before']),
                'not_after' => Carbon::parse((string) $d['not_after']), 'issued_reason' => 'enroll']);
            $tok->forceFill(['used_at' => Carbon::now(), 'used_by_server_id' => $server->id,
                'used_from_ip' => filter_var($clientIp, FILTER_VALIDATE_IP) !== false ? $clientIp : null])->save();
            $this->audit->record('server.join', $server, ['token' => $tok->uuid, 'fingerprint_sha256' => $d['fingerprint_sha256'],
                'hostname' => $in['hostname'], 'client_ip' => $clientIp], 'success', $server->id);

            return ['server_uuid' => $server->uuid, 'cert_pem' => (string) $d['cert_pem'], 'chain_pem' => (string) $d['chain_pem'],
                'ca_sha256' => (string) self::caPin(), 'hmac_key' => $hmac, 'relay_url' => $relayUrl,
                'cert_not_after' => Carbon::parse((string) $d['not_after'])->toIso8601String()];
        });
    }
}
