<?php

declare(strict_types=1);

namespace App\Domain\Backup;

use App\Domain\Jobs\Secrets;
use App\Exceptions\ApiProblem;
use App\Models\BackupDestination;
use App\Models\BackupRepository;
use App\Models\HostingAccount;
use App\Models\Server;

/**
 * Dựng params op agent backup.* (contracts/agent-ops): đích kiểu hóa, repo (mật khẩu + credential chỉ là tham chiếu
 * bí mật D-69), tag theo danh sách cố định (D-82). Kiểm cấu hình đích theo ADR 0030.
 */
final class BackupSpec
{
    public const TYPES = ['local', 'sftp', 's3', 'rest'];

    public const LOCAL_PATH = '/var/backups/itso';

    /** Khóa config được phép theo loại (không bí mật) và credential (ghi). */
    public const FIELDS = [
        'local' => ['config' => ['path'], 'credentials' => []],
        'sftp' => ['config' => ['host', 'port', 'user', 'path'], 'credentials' => []],
        's3' => ['config' => ['endpoint', 'bucket', 'region'], 'credentials' => ['access_key', 'secret_key']],
        'rest' => ['config' => ['url', 'user'], 'credentials' => ['password']],
    ];

    /**
     * Kiểm + chuẩn hóa config/credentials theo loại; 422 theo trường.
     *
     * @param  array<string, mixed>  $config
     * @param  array<string, mixed>|null  $creds  null = giữ credential cũ (PATCH)
     * @return array{0: array<string, string>, 1: array<string, string>|null}
     */
    public static function normalize(string $type, array $config, ?array $creds, bool $requireCreds): array
    {
        $f = self::FIELDS[$type];
        foreach (array_keys($config) as $k) {
            if (! in_array($k, $f['config'], true)) {
                throw ApiProblem::field("config.$k", "Đích $type không có trường cấu hình này.");
            }
        }
        $c = array_map(fn ($v) => is_scalar($v) ? trim((string) $v) : '', $config);
        $need = fn (string $k) => ($c[$k] ?? '') !== '' ? $c[$k] : throw ApiProblem::field("config.$k", 'Bắt buộc.');
        $out = [];
        switch ($type) {
            case 'local':
                if (($c['path'] ?? self::LOCAL_PATH) !== self::LOCAL_PATH) {
                    throw ApiProblem::field('config.path', 'Đích local luôn ở '.self::LOCAL_PATH.' (root 0700, ADR 0030).');
                }
                $out = ['path' => self::LOCAL_PATH];
                break;
            case 'sftp':
                $host = strtolower($need('host'));
                if (preg_match('/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/', $host) !== 1 && filter_var($host, FILTER_VALIDATE_IP) === false) {
                    throw ApiProblem::field('config.host', 'Host không hợp lệ.');
                }
                $port = $c['port'] ?? '22';
                if (preg_match('/^\d{1,5}$/', $port) !== 1 || (int) $port < 1 || (int) $port > 65535) {
                    throw ApiProblem::field('config.port', 'Cổng 1–65535.');
                }
                $user = $need('user');
                if (preg_match('/^[a-z_][a-z0-9_.-]{0,31}$/', $user) !== 1) {
                    throw ApiProblem::field('config.user', 'User không hợp lệ.');
                }
                $path = $need('path');
                if (preg_match('#^/[A-Za-z0-9._/@+-]*$#', $path) !== 1 || preg_match('#(^|/)\.\.(/|$)#', $path) === 1 || $path === '/') {
                    throw ApiProblem::field('config.path', 'Đường dẫn tuyệt đối, không "..", không phải /.');
                }
                $out = ['host' => $host, 'port' => (string) (int) $port, 'user' => $user, 'path' => rtrim($path, '/')];
                break;
            case 's3':
                $out = ['endpoint' => self::https($need('endpoint'), 'config.endpoint'), 'bucket' => $need('bucket')];
                if (preg_match('/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/', $out['bucket']) !== 1) {
                    throw ApiProblem::field('config.bucket', 'Tên bucket không hợp lệ.');
                }
                if (($c['region'] ?? '') !== '') {
                    if (preg_match('/^[a-z0-9-]{2,32}$/', $c['region']) !== 1) {
                        throw ApiProblem::field('config.region', 'Region không hợp lệ.');
                    }
                    $out['region'] = $c['region'];
                }
                break;
            case 'rest':
                $out = ['url' => self::https($need('url'), 'config.url'), 'user' => $need('user')];
                if (preg_match('/^[a-z_][a-z0-9_.-]{0,31}$/', $out['user']) !== 1) {
                    throw ApiProblem::field('config.user', 'User không hợp lệ.');
                }
                break;
        }
        if ($creds === null) {
            return [$out, null];
        }
        foreach (array_keys($creds) as $k) {
            if (! in_array($k, $f['credentials'], true)) {
                throw ApiProblem::field("credentials.$k", "Đích $type không nhận credential này.");
            }
        }
        $cr = [];
        foreach ($f['credentials'] as $k) {
            $v = is_string($creds[$k] ?? null) ? $creds[$k] : '';
            if ($v === '' && $requireCreds) {
                throw ApiProblem::field("credentials.$k", 'Bắt buộc.');
            }
            if ($v !== '' && (preg_match('/^[\x21-\x7e]{8,256}$/', $v) !== 1 || ($k === 'access_key' && preg_match('#^[A-Za-z0-9/+=]{8,128}$#', $v) !== 1))) {
                throw ApiProblem::field("credentials.$k", 'Credential không hợp lệ (8–256 ký tự in được).');
            }
            $cr[$k] = $v;
        }

        return [$out, $cr];
    }

    private static function https(string $u, string $field): string
    {
        $p = parse_url($u);
        if (! is_array($p) || ($p['scheme'] ?? '') !== 'https' || ! isset($p['host']) || isset($p['user']) || isset($p['query']) || isset($p['fragment'])) {
            throw ApiProblem::field($field, 'Cần URL https:// không có user/query.');
        }
        $h = strtolower($p['host']);
        // Chống SSRF tới metadata/loopback/mạng nội bộ qua IP trần (tên miền: agent kiểm lại khi kết nối).
        if (filter_var($h, FILTER_VALIDATE_IP) !== false && filter_var($h, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
            throw ApiProblem::field($field, 'Không dùng IP nội bộ/loopback/link-local.');
        }

        return rtrim($u, '/');
    }

    /**
     * Đích dạng agent (BackupDestination của agent-ops); credential là tham chiếu bí mật.
     *
     * @return array<string, mixed>
     */
    public static function destination(BackupDestination $d): array
    {
        $c = $d->config;
        $ref = fn (string $k) => Secrets::ref('backup_dest_credential', $d->uuid.'/'.$k);

        return match ($d->type) {
            'local' => ['type' => 'local', 'destination_uuid' => $d->uuid],
            'sftp' => ['type' => 'sftp', 'destination_uuid' => $d->uuid, 'host' => $c['host'], 'port' => (int) $c['port'], 'user' => $c['user'],
                'path' => $c['path'], 'host_key_sha256' => $d->host_key_sha256],
            's3' => ['type' => 's3', 'destination_uuid' => $d->uuid, 'endpoint' => $c['endpoint'], 'bucket' => $c['bucket'],
                'region' => $c['region'] ?? null, 'access_key_id' => $ref('access_key'), 'secret_access_key' => $ref('secret_key')],
            'rest' => ['type' => 'rest', 'destination_uuid' => $d->uuid, 'url' => $c['url'], 'user' => $c['user'], 'password' => $ref('password')],
            default => throw new \LogicException('loại đích lạ'),
        };
    }

    /** @return array<string, mixed> BackupRepo của agent-ops */
    public static function repo(BackupRepository $r): array
    {
        return ['repo_uuid' => $r->uuid, 'path' => $r->path, 'destination' => self::destination($r->destination),
            'password' => Secrets::ref('backup_repo_password', $r->uuid)];
    }

    public static function repoPath(Server $s, ?HostingAccount $a): string
    {
        return 'itso/'.$s->uuid.'/'.($a !== null ? 'acct-'.$a->uuid : 'server');
    }

    /** @return array<string, mixed> meta của backup.run */
    public static function meta(Server $s, ?HostingAccount $a): array
    {
        $pkg = $a?->packageVersion?->package?->name;

        return ['panel_version' => preg_replace('/[^0-9A-Za-z.+-]/', '', (string) config('itso.version')) ?: '0',
            'server_uuid' => $s->uuid, 'account_uuid' => $a?->uuid, 'package' => is_string($pkg) ? mb_substr($pkg, 0, 80) : null];
    }
}
