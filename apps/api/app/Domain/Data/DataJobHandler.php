<?php

declare(strict_types=1);

namespace App\Domain\Data;

use App\Domain\Jobs\JobHandler;
use App\Models\CronJob;
use App\Models\CronRun;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\FileOperation;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\SftpAccount;
use App\Models\SshKey;
use App\Models\UploadSession;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Observed state của dữ liệu hosting khi job Phase 6 kết thúc (database.*, database_user.*, sftp_account.*, ssh_key.*,
 * cron_job.*, file.*). Tạo lỗi → failed; sửa lỗi → degraded + drift; xóa xong → xóa mềm.
 */
final class DataJobHandler implements JobHandler
{
    public const TYPES = ['database.create', 'database.delete', 'database.export', 'database.import',
        'database_user.create', 'database_user.delete', 'database_user.grants', 'database_user.rotate_password',
        'sftp_account.create', 'sftp_account.delete', 'sftp_account.rotate_password', 'ssh_key.create', 'ssh_key.delete',
        'cron_job.create', 'cron_job.update', 'cron_job.delete', 'cron_job.run', 'file.operate', 'file.upload'];

    public function succeeded(Job $job): void
    {
        $now = Carbon::now();
        $r = $this->resource($job);
        switch ($job->type) {
            case 'database.create':
                if ($r instanceof Database) {
                    $this->ready($r, $now);
                    $uid = $r->observed_facts['created_user_id'] ?? null;
                    if (is_int($uid) && ($u = DatabaseUser::query()->find($uid)) instanceof DatabaseUser) {
                        $this->ready($u, $now);
                    }
                }
                break;
            case 'database.delete':
            case 'database_user.delete':
                if ($r instanceof Database || $r instanceof DatabaseUser) {
                    DB::table('database_grants')->where($r instanceof Database ? 'database_id' : 'database_user_id', $r->id)->delete();
                    $r->observed_at = $now;
                    $r->save();
                    $r->delete();
                }
                break;
            case 'sftp_account.delete':
            case 'cron_job.delete':
                if ($r instanceof SftpAccount || $r instanceof CronJob) {
                    $r->observed_at = $now;
                    $r->save();
                    $r->delete();
                }
                $this->cronSettled($job, $now);
                break;
            case 'cron_job.create':
            case 'cron_job.update':
                $this->cronSettled($job, $now);
                break;
            case 'cron_job.run':
                $this->recordRun($job, true);
                break;
            case 'file.operate':
            case 'file.upload':
                $this->files($job, true);
                break;
            case 'ssh_key.create':
            case 'ssh_key.delete':
            case 'database.export':
            case 'database.import':
                break;
            default:
                if ($r instanceof Database || $r instanceof DatabaseUser || $r instanceof SftpAccount) {
                    $this->ready($r, $now);
                }
        }
    }

    public function failed(Job $job): void
    {
        $now = Carbon::now();
        $r = $this->resource($job);
        $msg = mb_substr((string) ($job->error_message ?? $job->state), 0, 300);
        switch ($job->type) {
            case 'database.create':
            case 'database_user.create':
            case 'sftp_account.create':
            case 'cron_job.create':
                if ($r instanceof Model && $r->getAttribute('status') !== null) {
                    $r->fill(['status' => 'failed', 'drift' => ['apply' => $msg], 'observed_at' => $now])->save();
                    $uid = $r instanceof Database ? ($r->observed_facts['created_user_id'] ?? null) : null;
                    if (is_int($uid)) {
                        DatabaseUser::query()->whereKey($uid)->update(['status' => 'failed', 'observed_at' => $now]);
                    }
                }
                break;
            case 'ssh_key.create':
                // Khóa chưa vào authorized_keys: gỡ bản ghi để panel khớp máy.
                if ($r instanceof SshKey) {
                    $r->delete();
                }
                break;
            case 'cron_job.run':
                $this->recordRun($job, false);
                break;
            case 'file.operate':
            case 'file.upload':
                $this->files($job, false);
                break;
            case 'database.export':
            case 'database.import':
            case 'ssh_key.delete':
                break;
            default:
                if ($r instanceof Model && $r->getAttribute('status') !== null) {
                    $r->fill(['status' => 'degraded', 'drift' => ['apply' => $msg], 'observed_at' => $now])->save();
                }
        }
    }

    /**
     * Trạng thái tài nguyên dữ liệu theo trạng thái account sau job tạm khóa/mở khóa (gọi từ AccountJobHandler).
     */
    public static function accountSettled(HostingAccount $a, bool $live): void
    {
        $from = $live ? ['suspended'] : ['ready', 'degraded'];
        foreach ([Database::class, DatabaseUser::class, CronJob::class] as $m) {
            $m::query()->where('hosting_account_id', $a->id)->whereIn('status', $from)
                ->update(['status' => $live ? 'ready' : 'suspended', 'observed_at' => Carbon::now()]);
        }
        SftpAccount::query()->where('hosting_account_id', $a->id)->whereIn('status', $from)
            ->update(['status' => $live ? 'ready' : 'suspended', 'observed_at' => Carbon::now()]);
    }

    private function ready(Database|DatabaseUser|SftpAccount|CronJob $m, Carbon $now): void
    {
        $m->fill(['status' => 'ready', 'observed_version' => $m->spec_version, 'observed_at' => $now, 'drift' => null])->save();
    }

    /** cron.apply áp toàn bộ desired state của account: mọi cron đang provisioning/degraded của account đã khớp máy. */
    private function cronSettled(Job $job, Carbon $now): void
    {
        $step = JobStep::query()->where('job_id', $job->id)->where('op', 'cron.apply')->first();
        if (! $step instanceof JobStep) {
            return;
        }
        $acct = $step->params_redacted['account']['username'] ?? null;
        $a = HostingAccount::query()->where('username', $acct)->first();
        if (! $a instanceof HostingAccount) {
            return;
        }
        foreach (CronJob::query()->where('hosting_account_id', $a->id)->whereIn('status', ['provisioning', 'degraded'])->get() as $c) {
            $this->ready($c, $now);
        }
    }

    private function recordRun(Job $job, bool $ok): void
    {
        $c = $this->resource($job);
        if (! $c instanceof CronJob) {
            return;
        }
        $res = JobStep::query()->where('job_id', $job->id)->where('op', 'cron.run_once')->value('result');
        $res = is_string($res) ? json_decode($res, true) : $res;
        $res = is_array($res) ? $res : [];
        $exit = $ok ? (int) ($res['exit_code'] ?? 0) : null;
        $status = match (true) {
            ! $ok => 'failed',
            (bool) ($res['timed_out'] ?? false) => 'timed_out',
            $exit === 0 => 'succeeded',
            default => 'failed',
        };
        $started = isset($res['started_at']) ? Carbon::parse((string) $res['started_at']) : ($job->started_at ?? Carbon::now());
        CronRun::query()->create(['cron_job_id' => $c->id, 'started_at' => $started,
            'finished_at' => isset($res['finished_at']) ? Carbon::parse((string) $res['finished_at']) : Carbon::now(),
            'exit_code' => $exit, 'status' => $status, 'trigger' => 'manual',
            'output_tail' => mb_substr((string) ($ok ? ($res['output_tail'] ?? '') : ($job->error_message ?? '')), -8192)]);
        $c->last_run_at = $started;
        $c->last_status = $status;
        $c->save();
    }

    private function files(Job $job, bool $ok): void
    {
        FileOperation::query()->where('job_id', $job->id)->update(['status' => $ok ? 'succeeded' : 'failed',
            'error_code' => $ok ? null : mb_substr((string) ($job->error_code ?? 'failed'), 0, 64)]);
        foreach (UploadSession::query()->where('job_id', $job->id)->get() as $u) {
            $u->status = $ok ? 'completed' : 'failed';
            $u->save();
            if (! $ok) {
                @unlink(FileService::staging($u));
            }
        }
    }

    private function resource(Job $job): ?Model
    {
        $m = match ($job->resource_type) {
            'database' => Database::class,
            'database_user' => DatabaseUser::class,
            'sftp_account' => SftpAccount::class,
            'ssh_key' => SshKey::class,
            'cron_job' => CronJob::class,
            default => null,
        };
        if ($m === null || $job->resource_id === null) {
            return null;
        }
        $q = $m === SshKey::class ? $m::query() : $m::withTrashed();

        return $q->find($job->resource_id);
    }
}
