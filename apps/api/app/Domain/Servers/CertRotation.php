<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use App\Domain\Audit\AuditLogger;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentResult;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Infrastructure\Agent\RelayClient;
use App\Models\Agent;
use App\Models\AgentCertificate;
use App\Models\Server;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use RuntimeException;

/**
 * Xoay chứng chỉ node khi qua 2/3 hạn (ADR 0036 §3): agent.cert.rotate pha 1 (node sinh khóa chờ + CSR) →
 * pki.sign_csr trên agent local → agent.cert.rotate pha 2 (node cài chứng chỉ khớp khóa chờ). Chứng chỉ cũ được
 * thu hồi (superseded) nên relay cắt kết nối cũ, node quay số lại bằng chứng chỉ mới.
 */
final class CertRotation
{
    private const SYSTEM = ['user_uuid' => null, 'role' => 'SYSTEM'];

    public function __construct(private readonly AgentClient $agent, private readonly RelayClient $relay,
        private readonly AuditLogger $audit) {}

    public static function due(Agent $a, ?Carbon $now = null): bool
    {
        if ($a->cert_not_before === null || $a->cert_expires_at === null) {
            return false;
        }
        $life = $a->cert_not_before->diffInSeconds($a->cert_expires_at, true);

        return ($now ?? Carbon::now())->gte($a->cert_not_before->copy()->addSeconds((int) ($life * 2 / 3)));
    }

    /** @return array{rotated: int, skipped: int, failed: list<string>} */
    public function run(bool $force = false): array
    {
        $out = ['rotated' => 0, 'skipped' => 0, 'failed' => []];
        $agents = Agent::query()->where('transport', 'mtls')->whereNull('revoked_at')->whereNotNull('hmac_key_encrypted')->get();
        foreach ($agents as $a) {
            $server = Server::query()->find($a->server_id);
            if (! $server instanceof Server || (! $force && ! self::due($a))) {
                $out['skipped']++;

                continue;
            }
            try {
                $this->rotate($server, $a);
                $out['rotated']++;
            } catch (AgentUnavailable|RuntimeException $e) {
                $out['failed'][] = $server->name.': '.$e->getMessage();
            }
        }
        if ($out['rotated'] > 0) {
            RelaySync::pushRevocations($this->relay);
        }

        return $out;
    }

    /** @return array<string, mixed> */
    private function ok(AgentResult $r, string $op): array
    {
        if (! $r->ok || ! is_array($r->data)) {
            throw new RuntimeException($op.': '.(string) ($r->error['message'] ?? 'lỗi'));
        }

        return $r->data;
    }

    public function rotate(Server $server, Agent $a): void
    {
        $node = $this->agent->forServer($server->id);
        $p1 = $this->ok($node->call('agent.cert.rotate', ['server_uuid' => $server->uuid, 'cert_pem' => null],
            (string) Str::uuid7().':1:1', self::SYSTEM, 60.0), 'agent.cert.rotate (CSR)');
        $csr = $p1['csr'] ?? null;
        if (! is_string($csr) || $csr === '') {
            throw new RuntimeException('agent.cert.rotate không trả CSR');
        }
        $signed = $this->ok($this->agent->forServer(null)->call('pki.sign_csr', ['server_uuid' => $server->uuid, 'csr' => $csr,
            'ttl_days' => NodeEnrollment::CERT_TTL_DAYS], (string) Str::uuid7().':1:1', self::SYSTEM, 30.0), 'pki.sign_csr');
        $p2 = $this->ok($node->call('agent.cert.rotate', ['server_uuid' => $server->uuid, 'cert_pem' => (string) $signed['cert_pem']],
            (string) Str::uuid7().':1:1', self::SYSTEM, 60.0), 'agent.cert.rotate (cài)');
        if (($p2['installed'] ?? false) !== true || ($p2['fingerprint_sha256'] ?? null) !== $signed['fingerprint_sha256']) {
            throw new RuntimeException('node không cài chứng chỉ mới');
        }
        DB::transaction(function () use ($server, $a, $signed): void {
            $nb = Carbon::parse((string) $signed['not_before']);
            $na = Carbon::parse((string) $signed['not_after']);
            AgentCertificate::query()->where('server_id', $server->id)->whereNull('revoked_at')
                ->update(['revoked_at' => Carbon::now(), 'revoked_reason' => 'superseded']);
            AgentCertificate::query()->create(['server_id' => $server->id, 'serial' => (string) $signed['serial'],
                'fingerprint_sha256' => (string) $signed['fingerprint_sha256'], 'not_before' => $nb, 'not_after' => $na,
                'issued_reason' => 'rotate']);
            $old = $a->cert_fingerprint;
            $a->forceFill(['cert_fingerprint' => (string) $signed['fingerprint_sha256'], 'cert_not_before' => $nb,
                'cert_expires_at' => $na, 'cert_rotated_at' => Carbon::now()])->save();
            $this->audit->record('server.cert_rotate', $server, ['from' => $old, 'to' => $signed['fingerprint_sha256']], 'success', $server->id);
        });
    }
}
