<?php

declare(strict_types=1);

namespace App\Domain\Audit;

use App\Auth\SessionKeys;
use App\Domain\Jobs\Secrets;
use App\Models\AuditLog;
use App\Models\ImpersonationSession;
use App\Models\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Request;

/**
 * Ghi audit_logs (append-only, hash chain do trigger DB tính). Actor, người giả danh, IP, UA lấy từ request.
 * Giá trị nhạy cảm trong `changes` được che trước khi ghi.
 */
final class AuditLogger
{
    private const SECRET_KEYS = ['password', 'password_hash', 'current_password', 'new_password', 'token', 'token_hash',
        'secret', 'secret_encrypted', 'recovery_codes', 'ticket', 'private_key_pem', 'private_key', 'api_token', 'credentials'];

    public function __construct(private readonly Request $request) {}

    /** @param  array<string, mixed>|null  $changes */
    public function record(string $action, ?Model $resource = null, ?array $changes = null, string $result = 'success',
        ?int $serverId = null, ?int $jobId = null, ?User $actor = null): AuditLog
    {
        $actor ??= $this->request->user();

        return AuditLog::query()->create([
            'actor_user_id' => $actor instanceof User ? $actor->id : null,
            'impersonator_user_id' => $this->impersonatorId(),
            'actor_ip' => $this->request->ip(),
            'user_agent' => mb_substr((string) $this->request->userAgent(), 0, 500) ?: null,
            'action' => $action,
            'resource_type' => $resource !== null ? self::type($resource) : null,
            'resource_id' => $resource?->getKey(),
            'server_id' => $serverId,
            'job_id' => $jobId,
            'changes' => $changes !== null ? self::redact($changes) : null,
            'result' => $result,
        ]);
    }

    /**
     * @param  array<array-key, mixed>  $data
     * @return array<array-key, mixed>
     */
    public static function redact(array $data): array
    {
        foreach ($data as $k => $v) {
            if (Secrets::isRef($v)) {
                continue; // tham chiếu bí mật (JobRunner thay khi gọi agent) không phải giá trị bí mật
            }
            if (is_string($k) && in_array(strtolower($k), self::SECRET_KEYS, true)) {
                $data[$k] = '[REDACTED]';
            } elseif (is_array($v)) {
                $data[$k] = self::redact($v);
            }
        }

        return $data;
    }

    public static function type(Model $m): string
    {
        return $m->getTable();
    }

    private function impersonatorId(): ?int
    {
        if (! $this->request->hasSession()) {
            return null;
        }
        $id = $this->request->session()->get(SessionKeys::IMPERSONATION_ID);
        if (! is_int($id)) {
            return null;
        }

        return ImpersonationSession::query()->whereKey($id)->value('staff_user_id');
    }
}
