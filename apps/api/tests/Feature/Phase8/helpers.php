<?php

// Hàm dùng chung cho test Phase 8 (không phải file test: tên không kết thúc bằng Test.php).

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Opis\JsonSchema\Errors\ErrorFormatter;
use Opis\JsonSchema\Validator;
use Tests\Support\FakeAgent;
use Tests\Support\OpenApi;
use Tests\Support\Spa;

if (! defined('P8A')) {
    define('P8A', 'itso-admin-v1.yaml');
    define('P8P', 'itso-portal-v1.yaml');
}

function p8(Spa $spa, string $method, string $uri, array $body = [], array $headers = []): TestResponse
{
    return $spa->call($method, $uri, $body, $headers + ['Idempotency-Key' => (string) Str::uuid()]);
}

/** Các bảng không bao giờ được chứa bí mật (mật khẩu repo, credential đích, khóa age riêng). */
function p8leak(string $secret): ?string
{
    foreach (['job_steps', 'job_logs', 'audit_logs', 'jobs', 'backup_destinations', 'backup_snapshots', 'restore_jobs'] as $t) {
        if (DB::table($t)->get()->contains(fn ($row) => str_contains(json_encode($row), $secret))) {
            return $t;
        }
    }

    return null;
}

/** Kiểm params/result một op theo contracts/agent-ops (đúng schema agent thật sẽ kiểm lại). */
function p8schema(string $op, mixed $data, string $part): ?string
{
    static $v = null;
    $dir = dirname(OpenApi::contractsDir()).'/agent-ops';
    if ($v === null) {
        $v = new Validator;
        $v->setMaxErrors(5);
        $v->resolver()->registerFile('https://schemas.itso.local/agent-ops/defs.schema.json', $dir.'/defs.schema.json');
    }
    $file = "$dir/ops/$op.schema.json";
    if (! is_file($file)) {
        return "không có schema cho $op";
    }
    $id = "https://schemas.itso.local/agent-ops/ops/$op.schema.json";
    $v->resolver()->registerFile($id, $file);
    $res = $v->validate(json_decode(json_encode($data, JSON_PRESERVE_ZERO_FRACTION)), "$id#/\$defs/$part");

    return $res->isValid() ? null : "$op $part: ".json_encode((new ErrorFormatter)->format($res->error()), JSON_UNESCAPED_UNICODE);
}

/**
 * Agent giả cho backup: kết quả đúng schema; mọi params/result được kiểm theo contracts (lỗi gom vào $errors).
 *
 * @param  array<string, callable>  $over
 */
function p8agent(array &$errors, array $over = []): FakeAgent
{
    $snap = fn () => bin2hex(random_bytes(8));
    $base = [
        'backup.repo.init' => fn () => ['initialized' => true, 'already_existed' => false],
        'backup.run' => fn () => ['snapshot_id' => $snap(), 'size_bytes' => 3145728, 'bytes_added' => 1000, 'files_new' => 3, 'duration_ms' => 12,
            'manifest_sha256' => hash('sha256', 'manifest')],
        'backup.stats' => fn () => ['raw_size_bytes' => 5242880, 'restore_size_bytes' => 6291456, 'snapshots' => 2],
        'backup.destination.test' => fn () => ['ok' => true, 'error' => null, 'latency_ms' => 4, 'append_only' => false, 'object_lock_days' => null,
            'host_key_sha256' => null, 'ssh_public_key' => null],
        'backup.check' => fn () => ['ok' => true, 'errors' => [], 'duration_ms' => 20],
        'backup.restore_test' => fn () => ['ok' => true, 'verified_files' => 12, 'mismatches' => [], 'databases_ok' => 0],
        'backup.forget' => fn (array $env) => ['forgotten' => count($env['params']['snapshot_ids']), 'pruned' => true],
        'backup.restore' => fn (array $env) => ['restored_paths' => ['backups/restore-1121/sites/demo.vn'], 'databases' => array_values(array_map(
            fn ($i) => $i['target_name'], array_filter($env['params']['items'], fn ($i) => $i['kind'] === 'database'))),
            'pre_restore_snapshot_id' => $env['params']['mode'] === 'overwrite' ? $snap() : null, 'skipped' => []],
        'backup.browse' => fn () => ['entries' => [
            ['name' => 'sites', 'path' => 'sites', 'type' => 'dir', 'size' => 4096, 'mtime' => '2026-11-20T08:00:00Z', 'mode' => '0755'],
            ['name' => 'notes.txt', 'path' => 'notes.txt', 'type' => 'file', 'size' => 13, 'mtime' => '2026-11-20T08:00:00Z', 'mode' => '0644'],
        ], 'truncated' => false],
        'backup.file.read' => function (array $env) {
            $all = 'xin chao itso';
            $off = (int) $env['params']['offset'];

            return ['content_b64' => base64_encode(substr($all, $off, 5)), 'size' => strlen($all), 'eof' => $off + 5 >= strlen($all)];
        },
        'account.remove' => fn () => ['removed_objects' => [['kind' => 'home', 'name' => '/home/x', 'sha256' => null]]],
    ];
    $handlers = [];
    foreach ($over + $base as $op => $h) {
        $handlers[$op] = function (array $env) use ($op, $h, &$errors) {
            if (($e = p8schema($op, $env['params'], 'params')) !== null) {
                $errors[] = $e;
            }
            $out = $h($env);
            if (! isset($out['__error']) && ($e = p8schema($op, $out, 'result')) !== null) {
                $errors[] = $e;
            }

            return $out;
        };
    }
    $handlers['*'] = fn () => ['ok' => true];

    return new FakeAgent($handlers);
}
