<?php

declare(strict_types=1);

namespace App\Domain\Data;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Exceptions\ApiProblem;
use App\Models\CronJob;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\SftpAccount;
use App\Models\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

/**
 * Khung chung cho thay đổi dữ liệu hosting (Phase 6): khóa account FOR UPDATE (đếm quota không đua), chỉ account
 * active mới tạo/sửa, tài nguyên không có job đang chạy, ghi desired state → tạo job → audit trong một transaction.
 */
final class DataJobs
{
    public const ACTIVE = ['queued', 'running', 'cancel_requested'];

    /** Tài nguyên có cột last_job_id (job gần nhất áp desired state). */
    private const TRACKED = [Database::class, DatabaseUser::class, SftpAccount::class, CronJob::class];

    public function __construct(private readonly JobDispatcher $jobs, private readonly AuditLogger $audit) {}

    /**
     * @param  callable(HostingAccount): array{0: Model, 1: JobSpec, 2: array<string, mixed>}  $build
     *                                                                                                 trả [tài nguyên, job, thay đổi để audit]
     * @param  (callable(Job): void)|null  $after
     * @return array{0: Model, 1: Job}
     */
    public function run(User $actor, HostingAccount $a, string $action, callable $build, bool $requireActive = true, ?callable $after = null): array
    {
        return DB::transaction(function () use ($actor, $a, $action, $build, $requireActive, $after): array {
            /** @var HostingAccount $acc */
            $acc = HostingAccount::query()->lockForUpdate()->findOrFail($a->id);
            if ($requireActive && $acc->lifecycle_state !== 'active') {
                throw new ApiProblem(409, 'invalid_state_transition', 'Account không hoạt động',
                    "Account đang {$acc->lifecycle_state}: không thay đổi được tài nguyên.");
            }
            [$resource, $spec, $changes] = $build($acc);
            $job = $this->jobs->dispatch($spec, $actor);
            if (in_array($resource::class, self::TRACKED, true)) {
                $resource->newQuery()->whereKey($resource->getKey())->update(['last_job_id' => $job->id]);
                $resource->setAttribute('last_job_id', $job->id);
            }
            $this->audit->record($action, $resource, $changes, 'success', $acc->server_id, $job->id, $actor);
            if ($after !== null) {
                $after($job); // trong transaction: job (queue sync/afterCommit) chạy sau khi các liên kết này đã ghi
            }

            return [$resource, $job];
        });
    }

    /** 409 nếu tài nguyên còn job chưa xong. */
    public static function ensureIdle(Model $m): void
    {
        $id = $m->getAttribute('last_job_id');
        if ($id !== null && Job::query()->whereKey($id)->whereIn('state', self::ACTIVE)->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'Tài nguyên đang có tác vụ chạy', 'Chờ tác vụ hiện tại xong rồi thử lại.');
        }
    }

    public static function spec(string $type, Model $resource, HostingAccount $a, int $timeout = 600): JobSpec
    {
        return new JobSpec($type, $resource, $a->server_id, 3, $timeout);
    }
}
