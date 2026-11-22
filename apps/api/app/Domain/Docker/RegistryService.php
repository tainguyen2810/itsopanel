<?php

declare(strict_types=1);

namespace App\Domain\Docker;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Domain\Jobs\Secrets;
use App\Exceptions\ApiProblem;
use App\Models\DockerHost;
use App\Models\Job;
use App\Models\Registry;
use App\Models\Server;
use App\Models\User;
use Illuminate\Support\Facades\Crypt;

/**
 * Registry image riêng (D-98): mật khẩu chỉ lưu Crypt, không bao giờ trả ra API hay ghi vào params job/audit;
 * tới agent qua tham chiếu bí mật `registry_password:<uuid>` do JobRunner thay ngay trước khi gửi.
 */
final class RegistryService
{
    public function __construct(private readonly JobDispatcher $jobs, private readonly AuditLogger $audit) {}

    /** @param array<string, mixed> $in RegistryInput đã validate cú pháp */
    public function create(User $actor, array $in): Registry
    {
        $url = rtrim((string) $in['url'], '/');
        if (preg_match('#^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$#', $url) !== 1) {
            throw ApiProblem::field('url', 'URL registry phải là https://host[:cổng][/đường-dẫn].');
        }
        $user = isset($in['username']) && $in['username'] !== '' ? (string) $in['username'] : null;
        $pass = isset($in['password']) && $in['password'] !== '' ? (string) $in['password'] : null;
        if ($user !== null && preg_match('/^[A-Za-z0-9._@-]{1,200}$/', $user) !== 1) {
            throw ApiProblem::field('username', 'Username chỉ gồm chữ, số và . _ @ - (tối đa 200 ký tự).');
        }
        if ($pass !== null && preg_match('/^[\x21-\x7e]{1,1024}$/', $pass) !== 1) {
            throw ApiProblem::field('password', 'Mật khẩu/token gồm ký tự in được, không khoảng trắng, tối đa 1024 ký tự.');
        }
        if (($user === null) !== ($pass === null)) {
            throw ApiProblem::field($user === null ? 'username' : 'password', 'Cần cả username và mật khẩu (hoặc bỏ trống cả hai).');
        }
        if (Registry::withTrashed()->where('name', (string) $in['name'])->exists()) {
            throw ApiProblem::conflict('Đã có registry tên '.$in['name'].'.');
        }
        $r = Registry::query()->create(['name' => (string) $in['name'], 'url' => $url, 'username' => $user,
            'password_encrypted' => $pass !== null ? Crypt::encryptString($pass) : null, 'created_by_user_id' => $actor->id]);
        $this->audit->record('registry.create', $r, ['name' => $r->name, 'url' => $url, 'username' => $user,
            'password' => $pass !== null ? 'set' : null], 'success', null, null, $actor);

        return $r->refresh();
    }

    public function delete(User $actor, Registry $r): void
    {
        $r->delete();
        $this->audit->record('registry.delete', $r, ['name' => $r->name], 'success', null, null, $actor);
    }

    /** Thử đăng nhập trên một server đã bật Docker (registry dùng chung toàn panel). */
    public function test(User $actor, Registry $r): Job
    {
        if ($r->username === null || $r->password_encrypted === null) {
            throw new ApiProblem(409, 'precondition_failed', 'Registry công khai', 'Registry không có credential để kiểm tra.');
        }
        $host = DockerHost::query()->where('enabled', true)->orderBy('server_id')->first();
        $s = $host instanceof DockerHost ? Server::query()->find($host->server_id) : null;
        if (! $s instanceof Server) {
            throw new ApiProblem(409, 'precondition_failed', 'Chưa có server bật Docker', 'Bật Docker trên ít nhất một máy chủ trước.');
        }
        $job = $this->jobs->dispatch((new JobSpec('registry.test', $r, $s->id, maxAttempts: 1, timeoutSec: 120))
            ->step('docker.registry.login', self::loginParams($r)), $actor);
        $this->audit->record('registry.test', $r, ['server' => $s->uuid], 'success', $s->id, $job->id, $actor);

        return $job;
    }

    /** @return array{registry_uuid: string, url: string, username: string, password: array{'$secret': string}} */
    public static function loginParams(Registry $r): array
    {
        return ['registry_uuid' => $r->uuid, 'url' => $r->url, 'username' => (string) $r->username,
            'password' => Secrets::ref('registry_password', $r->uuid)];
    }

    /** @return array<string, mixed> Registry */
    public static function present(Registry $r): array
    {
        return ['uuid' => $r->uuid, 'name' => $r->name, 'url' => $r->url, 'username' => $r->username,
            'last_test' => $r->last_test_at !== null ? ['ok' => (bool) $r->last_test_ok, 'message' => (string) ($r->last_test_message ?? ''),
                'at' => $r->last_test_at->toIso8601String()] : null,
            'created_at' => $r->created_at->toIso8601String(), 'updated_at' => $r->updated_at->toIso8601String()];
    }
}
