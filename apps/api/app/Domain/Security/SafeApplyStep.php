<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Domain\Jobs\PanelStep;
use App\Domain\Jobs\PanelStepFailed;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentResult;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\FirewallApply;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;

/**
 * Bước job firewall.apply / sshd.config.apply / *.confirm chạy trong panel để token xác nhận không đi qua
 * job_steps (kết quả lưu đã bỏ token). op_id cố định theo job + seq (attempt 0) nên chạy lại không tạo lần áp
 * dụng thứ hai: agent trả kết quả đã lưu (cùng token).
 */
abstract class SafeApplyStep implements PanelStep
{
    public function __construct(protected readonly AgentClient $agent, protected readonly SafeApply $safe) {}

    abstract protected function op(): string;

    abstract protected function confirm(): bool;

    public function run(array $params, Job $job): array
    {
        /** @var FirewallApply|null $a */
        $a = FirewallApply::query()->where('uuid', (string) ($params['apply_id'] ?? ''))->first();
        if ($a === null) {
            throw new PanelStepFailed('not_found', 'Không tìm thấy lần áp dụng.');
        }

        return $this->confirm() ? $this->doConfirm($a, $job) : $this->doApply($a, $params, $job);
    }

    /**
     * @param  array<string, mixed>  $params
     * @return array<string, mixed>
     */
    private function doApply(FirewallApply $a, array $params, Job $job): array
    {
        if ($a->status !== 'pending_confirm') {
            throw new PanelStepFailed('precondition_failed', "Lần áp dụng đang ở trạng thái {$a->status}.");
        }
        $res = $this->call($params, $job);
        if (! $res->ok) {
            if ($res->error === null || ! $res->error['retryable']) {
                FirewallApply::query()->whereKey($a->id)->update(['status' => 'failed']);
            }
            $this->fail($res);
        }
        $d = (array) $res->data;
        SafeApply::rememberToken($a, (string) ($d['token'] ?? ''), Carbon::parse((string) ($d['rollback_at'] ?? 'now')));
        if (isset($d['ruleset_sha256'])) {
            FirewallApply::query()->whereKey($a->id)->update(['ruleset_sha256' => (string) $d['ruleset_sha256']]);
        }
        unset($d['token']);

        return $d;
    }

    /** @return array<string, mixed> */
    private function doConfirm(FirewallApply $a, Job $job): array
    {
        if ($a->status === 'confirmed') {
            return ['confirmed' => true, 'rolled_back' => false];
        }
        $token = SafeApply::token($a);
        if ($a->status !== 'pending_confirm' || $token === null || $a->deadline_at->isPast()) {
            $this->safe->rolledBack($a, 'Xác nhận quá muộn: cấu hình đã được hoàn tác.');
            throw new PanelStepFailed('precondition_failed', 'Đã quá hạn xác nhận; cấu hình trước đó đã được khôi phục.');
        }
        $res = $this->call(['apply_id' => $a->uuid, 'token' => $token], $job);
        if (! $res->ok) {
            $this->fail($res);
        }
        $d = (array) $res->data;
        if (($d['rolled_back'] ?? false) === true) {
            $this->safe->rolledBack($a, 'Agent báo đã hoàn tác trước khi nhận xác nhận.');
            throw new PanelStepFailed('precondition_failed', 'Đã quá hạn xác nhận; cấu hình trước đó đã được khôi phục.');
        }
        FirewallApply::query()->whereKey($a->id)->update(['status' => 'confirmed', 'confirmed_at' => Carbon::now()]);
        Cache::forget(SafeApply::cacheKey($a->uuid));

        return ['confirmed' => true, 'rolled_back' => false];
    }

    /** @param  array<string, mixed>  $params */
    private function call(array $params, Job $job): AgentResult
    {
        $seq = (int) JobStep::query()->where('job_id', $job->id)->where('op', $this->op())->where('state', 'running')->value('seq');
        $u = $job->requested_by_user_id !== null ? User::query()->find($job->requested_by_user_id) : null;
        $by = $u instanceof User ? ['user_uuid' => $u->uuid, 'role' => $u->roleKey() ?? 'SYSTEM'] : null;
        try {
            return $this->agent->call($this->op(), $params, $job->uuid.':'.max(1, $seq).':0', $by, 60.0);
        } catch (AgentUnavailable $e) {
            throw new PanelStepFailed('agent_unavailable', mb_substr($e->getMessage(), 0, 300), true);
        }
    }

    private function fail(AgentResult $res): never
    {
        $e = $res->error ?? ['code' => 'internal', 'message' => 'Lỗi agent', 'retryable' => false];
        throw new PanelStepFailed((string) $e['code'], (string) $e['message'], $e['retryable']);
    }
}
