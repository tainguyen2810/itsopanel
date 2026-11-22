<?php

declare(strict_types=1);

namespace App\Domain\Data;

use App\Domain\Audit\AuditLogger;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentResult;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\FileOperation;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\UploadSession;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * File Manager (Prompt 6.3, D-72). Đọc/liệt kê/ghi editor gọi agent đồng bộ (helper hạ quyền dưới uid account);
 * thao tác hàng loạt (move/copy/delete/chmod/nén/giải nén) và commit upload chạy bằng job. Upload kiểu tus: chunk ghi
 * vào thư mục staging của panel (đúng offset), chunk cuối tạo job `fs.upload.commit`. Tải xuống: URL ký số 5 phút,
 * stream theo khúc qua `fs.read`. Mọi thay đổi ghi file_operations + audit.
 */
final class FileService
{
    public const MAX_EDIT = 2 * 1024 * 1024;

    public const CHUNK = 8 * 1024 * 1024;

    public const READ_CHUNK = 1024 * 1024;

    public function __construct(
        private readonly AgentClient $agent,
        private readonly DataJobs $jobs,
        private readonly AuditLogger $audit,
    ) {}

    /** @return list<array<string, mixed>> FileEntry */
    public function list(User $actor, HostingAccount $a, string $path): array
    {
        $path = DataSpec::relPath($path);
        $d = $this->call($actor, $a, 'fs.list', ['account' => DataSpec::acct($a), 'path' => $path, 'show_hidden' => true, 'limit' => 5000]);
        $out = [];
        foreach ((array) ($d['entries'] ?? []) as $e) {
            $name = (string) ($e['name'] ?? '');
            $type = in_array($e['type'] ?? '', ['file', 'dir', 'symlink'], true) ? (string) $e['type'] : 'file';
            $out[] = ['name' => $name, 'path' => $path === '.' ? $name : $path.'/'.$name, 'type' => $type,
                'size' => (int) ($e['size'] ?? 0), 'mode' => self::mode((string) ($e['mode'] ?? '0644')), 'owner' => $a->username,
                'modified_at' => Carbon::parse((string) ($e['modified_at'] ?? 'now'))->toIso8601String()];
        }

        return $out;
    }

    /** @return array<string, mixed> FileContent */
    public function read(User $actor, HostingAccount $a, string $path): array
    {
        $path = DataSpec::relPath($path, 'path', false);
        $st = $this->call($actor, $a, 'fs.stat', ['account' => DataSpec::acct($a), 'path' => $path]);
        if (($st['exists'] ?? false) !== true) {
            throw new ApiProblem(404, 'not_found', 'Không tìm thấy file', "Không có $path trong home.");
        }
        if (($st['type'] ?? '') !== 'file') {
            throw ApiProblem::field('path', 'Chỉ mở được file thường trong editor.');
        }
        if ((int) ($st['size'] ?? 0) > self::MAX_EDIT) {
            throw ApiProblem::field('path', 'File lớn hơn 2 MiB: dùng tải xuống thay vì mở trong editor.');
        }
        $d = $this->call($actor, $a, 'fs.read', ['account' => DataSpec::acct($a), 'path' => $path, 'max_bytes' => self::MAX_EDIT]);
        $raw = base64_decode((string) ($d['content_b64'] ?? ''), true) ?: '';
        $utf8 = mb_check_encoding($raw, 'UTF-8') && ! str_contains($raw, "\0");
        $etag = '"'.((string) ($d['file_sha256'] ?? $d['sha256'] ?? '')).'"';

        return ['path' => $path, 'content' => $utf8 ? $raw : base64_encode($raw), 'encoding' => $utf8 ? 'utf-8' : 'base64', 'etag' => $etag];
    }

    /**
     * @param  array<string, mixed>  $in  FileWrite
     * @return array<string, mixed> FileEntry
     */
    public function write(User $actor, HostingAccount $a, array $in): array
    {
        $this->active($a);
        $path = DataSpec::relPath($in['path'] ?? null, 'path', false);
        $content = (string) $in['content'];
        if (($in['encoding'] ?? 'utf-8') === 'base64') {
            $content = base64_decode($content, true);
            if ($content === false) {
                throw ApiProblem::field('content', 'content không phải base64 hợp lệ.');
            }
        }
        if (strlen($content) > self::MAX_EDIT) {
            throw ApiProblem::field('content', 'Nội dung tối đa 2 MiB.');
        }
        $params = ['account' => DataSpec::acct($a), 'path' => $path, 'content_b64' => base64_encode($content)];
        $etag = $in['if_etag'] ?? null;
        if (is_string($etag) && $etag !== '') {
            $sha = trim($etag, '"');
            if (preg_match('/^[0-9a-f]{64}$/', $sha) !== 1) {
                throw new ApiProblem(412, 'precondition_failed', 'ETag không hợp lệ', 'Tải lại file rồi sửa lại.');
            }
            $params['if_sha256'] = $sha;
        }
        $res = $this->raw($actor, $a, 'fs.write', $params);
        if (! $res->ok && ($res->error['code'] ?? '') === 'precondition_failed') {
            throw new ApiProblem(412, 'precondition_failed', 'File đã bị sửa nơi khác', 'Tải lại file rồi sửa lại.');
        }
        $this->ensureOk($res);
        $this->log($actor, $a, 'write', [$path], null, 'succeeded');
        $st = $this->call($actor, $a, 'fs.stat', ['account' => DataSpec::acct($a), 'path' => $path]);

        return ['name' => basename($path), 'path' => $path, 'type' => 'file', 'size' => (int) ($st['size'] ?? strlen($content)),
            'mode' => self::mode((string) ($st['mode'] ?? '0644')), 'owner' => $a->username,
            'modified_at' => Carbon::parse((string) ($st['modified_at'] ?? 'now'))->toIso8601String()];
    }

    /** @param  array<string, mixed>  $in  FileOperation */
    public function operate(User $actor, HostingAccount $a, array $in): Job
    {
        $op = (string) $in['op'];
        $paths = array_values(array_map(fn ($p): string => DataSpec::relPath($p, 'paths', false), (array) $in['paths']));
        $target = isset($in['target']) ? DataSpec::relPath($in['target'], 'target', $op !== 'rename' && $op !== 'compress') : null;
        $acct = DataSpec::acct($a);
        $needTarget = in_array($op, ['rename', 'move', 'copy', 'compress', 'extract'], true);
        if ($needTarget && $target === null) {
            throw ApiProblem::field('target', "Thao tác $op cần target.");
        }
        if (in_array($op, ['rename', 'extract'], true) && count($paths) !== 1) {
            throw ApiProblem::field('paths', "Thao tác $op nhận đúng một đường dẫn.");
        }
        $steps = match ($op) {
            'mkdir' => array_map(fn (string $p): array => ['fs.mkdir', ['account' => $acct, 'path' => $p, 'mode' => self::modeIn($in['mode'] ?? null, '0755')]], $paths),
            'rename' => [['fs.rename', ['account' => $acct, 'from' => $paths[0], 'to' => $target]]],
            'move' => [['fs.move', ['account' => $acct, 'paths' => $paths, 'target' => $target]]],
            'copy' => [['fs.copy', ['account' => $acct, 'paths' => $paths, 'target' => $target]]],
            'delete' => [['fs.delete', ['account' => $acct, 'paths' => $paths]]],
            'chmod' => [['fs.chmod', ['account' => $acct, 'paths' => $paths, 'mode' => self::modeIn($in['mode'] ?? null, null), 'recursive' => false]]],
            'compress' => [['fs.archive', ['account' => $acct, 'paths' => $paths, 'target' => $target, 'format' => (string) ($in['format'] ?? 'zip')]]],
            'extract' => [['fs.extract', ['account' => $acct, 'archive' => $paths[0], 'target' => $target,
                'max_total_bytes' => (int) config('itso.files.extract_max_bytes', 4 * 1024 * 1024 * 1024), 'max_entries' => 20000]]],
            default => throw ApiProblem::field('op', 'Thao tác không hỗ trợ.'),
        };
        if (in_array('.', $paths, true) && in_array($op, ['delete', 'move', 'rename', 'chmod'], true)) {
            throw ApiProblem::field('paths', 'Không thao tác trên chính thư mục home.');
        }
        $box = new class
        {
            public ?FileOperation $fo = null;
        };
        [, $job] = $this->jobs->run($actor, $a, 'file.operate', function (HostingAccount $acc) use ($op, $paths, $target, $steps, $actor, $box): array {
            $spec = DataJobs::spec('file.operate', $acc, $acc, 1800);
            foreach ($steps as [$o, $p]) {
                $spec->step($o, $p);
            }
            $spec->maxAttempts = 1;
            $box->fo = $fo = FileOperation::query()->create(['hosting_account_id' => $acc->id, 'user_id' => $actor->id, 'op' => $op,
                'paths' => $paths, 'target' => $target, 'status' => 'running']);

            return [$acc, $spec, ['file_operation' => $fo->uuid, 'op' => $op, 'paths' => array_slice($paths, 0, 20), 'target' => $target]];
        }, true, function (Job $job) use ($box): void {
            FileOperation::query()->whereKey($box->fo?->id)->update(['job_id' => $job->id]);
        });

        return $job;
    }

    // ---------- Upload (tus) ----------

    public function createUpload(User $actor, HostingAccount $a, string $path, int $size, bool $overwrite): UploadSession
    {
        $this->active($a);
        $path = DataSpec::relPath($path, 'path', false);
        $active = UploadSession::query()->where('user_id', $actor->id)->whereIn('status', ['receiving', 'committing'])
            ->where('expires_at', '>', Carbon::now())->count();
        if ($active >= 10) {
            throw new ApiProblem(409, 'resource_locked', 'Quá nhiều phiên upload', 'Tối đa 10 phiên upload đang mở mỗi người dùng.');
        }
        $u = UploadSession::query()->create(['user_id' => $actor->id, 'hosting_account_id' => $a->id, 'target_path' => $path,
            'size_bytes' => $size, 'received_bytes' => 0, 'overwrite' => $overwrite, 'status' => 'receiving', 'expires_at' => Carbon::now()->addDay()]);
        $dir = self::stagingDir();
        if (! is_dir($dir) && ! mkdir($dir, 0700, true) && ! is_dir($dir)) {
            throw new ApiProblem(503, 'agent_unavailable', 'Không tạo được thư mục staging', $dir);
        }
        touch(self::staging($u));
        chmod(self::staging($u), 0600);

        return $u;
    }

    /**
     * Ghi một chunk tại đúng offset. Sai offset → 409 (kèm received). Chunk cuối → job file.upload.
     *
     * @param  resource|string  $body
     */
    public function chunk(User $actor, UploadSession $u, string $range, $body, int $length): UploadSession
    {
        if ($u->status !== 'receiving' || $u->expires_at->isPast()) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Phiên upload không nhận dữ liệu', "Trạng thái: {$u->status}.");
        }
        if (preg_match('/^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/', $range, $m) !== 1) {
            throw ApiProblem::field('Content-Range', 'Content-Range dạng "bytes <đầu>-<cuối>/<tổng>".');
        }
        [$start, $end, $total] = [(int) $m[1], (int) $m[2], (int) $m[3]];
        if ($total !== $u->size_bytes || $end < $start || $end >= $total || $end - $start + 1 > self::CHUNK || $end - $start + 1 !== $length) {
            throw ApiProblem::field('Content-Range', 'Khoảng byte không khớp kích thước phiên, độ dài body hoặc vượt 8 MiB.');
        }
        if ($start !== $u->received_bytes) {
            throw new ApiProblem(409, 'conflict', 'Sai vị trí chunk', "Server đã nhận {$u->received_bytes} byte: gửi tiếp từ đó.",
                ['received' => [(string) $u->received_bytes]]);
        }
        $f = fopen(self::staging($u), 'c+b');
        if ($f === false) {
            throw new ApiProblem(409, 'conflict', 'Mất file staging', 'Tạo phiên upload mới.');
        }
        try {
            fseek($f, $start);
            $written = is_string($body) ? fwrite($f, $body) : stream_copy_to_stream($body, $f, $length);
            fflush($f);
        } finally {
            fclose($f);
        }
        if ($written !== $length) {
            throw ApiProblem::field('Content-Range', 'Body ngắn hơn khoảng byte khai báo.');
        }
        $u->received_bytes = $start + $length;
        $u->save();
        if ($u->received_bytes === $u->size_bytes) {
            $this->commit($actor, $u);
        }

        return $u->refresh();
    }

    public function cancelUpload(UploadSession $u): void
    {
        if ($u->status === 'committing') {
            throw new ApiProblem(409, 'resource_locked', 'Đang ghi file', 'Phiên upload đang được ghi vào home.');
        }
        @unlink(self::staging($u));
        if (in_array($u->status, ['receiving'], true)) {
            $u->status = 'cancelled';
            $u->save();
        }
    }

    private function commit(User $actor, UploadSession $u): void
    {
        /** @var HostingAccount $a */
        $a = HostingAccount::query()->findOrFail($u->hosting_account_id);
        $box = new class
        {
            public ?FileOperation $fo = null;
        };
        $this->jobs->run($actor, $a, 'file.upload', function (HostingAccount $acc) use ($u, $actor, $box): array {
            $spec = DataJobs::spec('file.upload', $acc, $acc, 1800)
                ->step('fs.upload.commit', ['account' => DataSpec::acct($acc), 'upload_uuid' => $u->uuid, 'target' => $u->target_path,
                    'size' => $u->size_bytes, 'overwrite' => $u->overwrite]);
            $box->fo = $fo = FileOperation::query()->create(['hosting_account_id' => $acc->id, 'user_id' => $actor->id, 'op' => 'upload',
                'paths' => [$u->target_path], 'target' => null, 'status' => 'running']);

            return [$acc, $spec, ['file_operation' => $fo->uuid, 'upload' => $u->uuid, 'path' => $u->target_path, 'size' => $u->size_bytes]];
        }, true, function (Job $job) use ($box, $u): void {
            FileOperation::query()->whereKey($box->fo?->id)->update(['job_id' => $job->id]);
            UploadSession::query()->whereKey($u->id)->update(['status' => 'committing', 'job_id' => $job->id]);
        });
    }

    public static function stagingDir(): string
    {
        return rtrim((string) config('itso.files.upload_dir', '/var/lib/itso/uploads'), '/');
    }

    public static function staging(UploadSession $u): string
    {
        return self::stagingDir().'/'.$u->uuid.'.part';
    }

    // ---------- Download ----------

    /** @return array{url: string, expires_at: string} */
    public function downloadLink(User $actor, HostingAccount $a, string $path, string $realm): array
    {
        $path = DataSpec::relPath($path, 'path', false);
        $exp = time() + 300;
        $url = url("/api/v1/$realm/hosting-accounts/{$a->uuid}/files/raw").'?'.http_build_query(['path' => $path, 'expires' => $exp,
            'signature' => self::sign($a, $path, $exp, $actor)]);

        return ['url' => $url, 'expires_at' => Carbon::createFromTimestamp($exp)->toIso8601String()];
    }

    public static function sign(HostingAccount $a, string $path, int $exp, User $u): string
    {
        return hash_hmac('sha256', "files.raw|{$a->uuid}|$path|$exp|{$u->id}", (string) config('app.key'));
    }

    /**
     * Kiểm chữ ký + hạn; trả [kích thước, tên].
     *
     * @return array{0: int, 1: string}
     */
    public function verifyDownload(User $actor, HostingAccount $a, string $path, mixed $exp, mixed $sig): array
    {
        $path = DataSpec::relPath($path, 'path', false);
        if (! is_string($exp) || ! ctype_digit($exp) || (int) $exp < time() || ! is_string($sig)
            || ! hash_equals(self::sign($a, $path, (int) $exp, $actor), $sig)) {
            throw new ApiProblem(403, 'forbidden', 'Link tải xuống không hợp lệ hoặc đã hết hạn', 'Tạo link mới.');
        }
        $st = $this->call($actor, $a, 'fs.stat', ['account' => DataSpec::acct($a), 'path' => $path]);
        if (($st['exists'] ?? false) !== true || ($st['type'] ?? '') !== 'file') {
            throw new ApiProblem(404, 'not_found', 'Không tìm thấy file', "Không có file $path.");
        }
        $this->audit->record('file.download', $a, ['path' => $path, 'size' => (int) ($st['size'] ?? 0)], 'success', $a->server_id, null, $actor);

        return [(int) ($st['size'] ?? 0), basename($path)];
    }

    /** Đọc một khúc (dùng trong StreamedResponse). */
    public function chunkAt(User $actor, HostingAccount $a, string $path, int $offset): string
    {
        $d = $this->call($actor, $a, 'fs.read', ['account' => DataSpec::acct($a), 'path' => $path, 'max_bytes' => self::READ_CHUNK, 'offset' => $offset]);

        return base64_decode((string) ($d['content_b64'] ?? ''), true) ?: '';
    }

    // ---------- tiện ích ----------

    private function active(HostingAccount $a): void
    {
        if ($a->lifecycle_state !== 'active') {
            throw new ApiProblem(409, 'invalid_state_transition', 'Account không hoạt động', "Account đang {$a->lifecycle_state}: không ghi file.");
        }
    }

    /** @param  list<string>  $paths */
    private function log(User $actor, HostingAccount $a, string $op, array $paths, ?string $target, string $status): void
    {
        $fo = FileOperation::query()->create(['hosting_account_id' => $a->id, 'user_id' => $actor->id, 'op' => $op, 'paths' => $paths,
            'target' => $target, 'status' => $status]);
        $this->audit->record('file.'.$op, $a, ['file_operation' => $fo->uuid, 'paths' => $paths], 'success', $a->server_id, null, $actor);
    }

    /** @param  array<string, mixed>  $params */
    private function raw(User $actor, HostingAccount $a, string $op, array $params): AgentResult
    {
        try {
            return $this->agent->forServer($a->server_id)->call($op, $params, (string) Str::uuid7().':1:1',
                ['user_uuid' => $actor->uuid, 'role' => $actor->roleKey() ?? 'SYSTEM'], 30.0);
        } catch (AgentUnavailable $e) {
            throw new ApiProblem(503, 'agent_unavailable', 'Agent không kết nối', mb_substr($e->getMessage(), 0, 200));
        }
    }

    /**
     * @param  array<string, mixed>  $params
     * @return array<string, mixed>
     */
    private function call(User $actor, HostingAccount $a, string $op, array $params): array
    {
        $res = $this->raw($actor, $a, $op, $params);
        $this->ensureOk($res);

        return (array) $res->data;
    }

    private function ensureOk(AgentResult $res): void
    {
        if ($res->ok) {
            return;
        }
        $code = (string) ($res->error['code'] ?? 'internal');
        $msg = mb_substr((string) ($res->error['message'] ?? 'Lỗi agent.'), 0, 300);
        throw match ($code) {
            'not_found' => new ApiProblem(404, 'not_found', 'Không tìm thấy', $msg),
            'path_outside_home', 'invalid_params' => ApiProblem::field('path', $msg),
            'already_exists' => new ApiProblem(409, 'conflict', 'Đã tồn tại', $msg),
            'quota_exceeded' => new ApiProblem(422, 'quota_exceeded', 'Vượt giới hạn dung lượng', $msg),
            'precondition_failed' => new ApiProblem(409, 'conflict', 'Không thực hiện được', $msg),
            default => new ApiProblem(503, 'agent_unavailable', 'Agent lỗi', $msg),
        };
    }

    private static function mode(string $m): string
    {
        $m = ltrim($m, '0');

        return '0'.str_pad(substr($m, -3), 3, '0', STR_PAD_LEFT);
    }

    private static function modeIn(mixed $m, ?string $default): string
    {
        if ($m === null && $default !== null) {
            return $default;
        }
        if (! is_string($m) || preg_match('/^0[0-7]{3}$/', $m) !== 1) {
            throw ApiProblem::field('mode', 'mode dạng 0755.');
        }

        return $m;
    }
}
