<?php

declare(strict_types=1);

namespace App\Domain\Docker;

use App\Domain\Jobs\JobHandler;
use App\Models\ComposeProject;
use App\Models\DockerContainer;
use App\Models\DockerHost;
use App\Models\ImageRollback;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\PortAllocation;
use App\Models\Registry;
use App\Models\ServerSoftware;
use Illuminate\Support\Carbon;

/** Ghi observed state khi job Docker/compose/registry kết thúc (D-94…D-98). */
final class DockerJobHandler implements JobHandler
{
    public const TYPES = ['docker.enable', 'docker.firewall_sync', 'docker.container_control', 'docker.image_prune',
        'docker.volume_remove', 'compose.create', 'compose.update', 'compose.validate', 'compose.up', 'compose.down',
        'compose.pull', 'compose.delete', 'compose.update_images', 'compose.rollback_images', 'registry.test'];

    public function succeeded(Job $job): void
    {
        $now = Carbon::now();
        if ($job->type === 'docker.enable' || $job->type === 'docker.firewall_sync') {
            $h = DockerHost::query()->find($job->server_id) ?? new DockerHost(['server_id' => $job->server_id]);
            $fill = ['firewall_synced_at' => $now];
            if ($job->type === 'docker.enable') {
                $fill += ['enabled' => true, 'state' => 'enabled', 'observed_at' => null, 'daemon_config' => array_merge($h->daemon_config ?? [],
                    ['daemon' => DockerHostService::DAEMON_DEFAULTS])];
                $sw = ServerSoftware::query()->firstOrNew(['server_id' => $job->server_id, 'software_key' => 'docker']);
                $res = $this->result($job, 'software.install');
                $sw->fill(['status' => 'ready', 'state' => 'installed', 'observed_at' => $now,
                    'version' => is_string($res['version'] ?? null) ? $res['version'] : ($sw->version ?? 'installed')]);
                if (! $sw->exists) {
                    $sw->fill(['spec_version' => 1, 'observed_version' => 1]);
                }
                $sw->save();
            }
            $h->fill($fill)->save();

            return;
        }
        if ($job->type === 'registry.test') {
            $r = Registry::withTrashed()->find($job->resource_id);
            $res = $this->result($job, 'docker.registry.login');
            $r?->fill(['last_test_at' => $now, 'last_test_ok' => ($res['ok'] ?? false) === true,
                'last_test_message' => mb_substr((string) ($res['message'] ?? ''), 0, 500)])->save();

            return;
        }
        $p = $job->resource_type === 'compose_project' ? ComposeProject::withTrashed()->find($job->resource_id) : null;
        if (! $p instanceof ComposeProject) {
            return;
        }
        switch ($job->type) {
            case 'compose.create':
            case 'compose.update':
                $svcs = array_values(array_filter((array) ($this->result($job, 'compose.apply')['services'] ?? []), 'is_array'));
                $running = count(array_filter($svcs, fn (array $s): bool => ($s['state'] ?? '') === 'running'));
                $p->forceFill(['status' => 'ready', 'observed_version' => $p->spec_version, 'observed_at' => $now, 'drift' => null,
                    'run_state' => $svcs === [] || $running === 0 ? 'stopped' : ($running === count($svcs) ? 'running' : 'partial'),
                    'observed_facts' => array_merge($p->observed_facts, ['services' => array_map(
                        fn (array $s): string => (string) $s['service'], $svcs)])])->save();
                break;
            case 'compose.up':
                $r = $this->result($job, 'compose.up');
                $total = (int) ($r['total'] ?? 0);
                $run = (int) ($r['running'] ?? 0);
                $p->forceFill(['run_state' => $total === 0 || $run === 0 ? 'stopped' : ($run >= $total ? 'running' : 'partial'),
                    'observed_at' => $now])->save();
                break;
            case 'compose.down':
                $p->forceFill(['run_state' => 'stopped', 'observed_at' => $now])->save();
                DockerContainer::query()->where('project_id', $p->id)->update(['state' => 'exited']);
                break;
            case 'compose.delete':
                // Trả cổng, bỏ cache, đổi tên (giải phóng unique server+name) rồi xóa mềm; volume được giữ lại.
                PortAllocation::query()->where('compose_project_id', $p->id)->delete();
                DockerContainer::query()->where('project_id', $p->id)->delete();
                $p->forceFill(['name' => substr($p->name, 0, 40).'-del'.$p->id, 'run_state' => 'stopped', 'status' => 'ready',
                    'observed_at' => $now])->save();
                $p->delete();
                break;
            case 'compose.update_images':
                $this->recordImageUpdate($job, $p);
                break;
            case 'compose.rollback_images':
                foreach ((array) ($this->result($job, 'docker.image.rollback')['services'] ?? []) as $s) {
                    if (is_array($s) && is_string($s['service'] ?? null)) {
                        ImageRollback::query()->where('compose_project_id', $p->id)->where('service', $s['service'])
                            ->where('state', 'succeeded')->whereNull('released_at')->orderByDesc('id')->limit(1)
                            ->update(['state' => 'rolled_back', 'reason' => 'Quay về thủ công', 'released_at' => $now]);
                    }
                }
                break;
        }
    }

    public function failed(Job $job): void
    {
        $now = Carbon::now();
        if ($job->type === 'docker.enable') {
            $h = DockerHost::query()->find($job->server_id);
            if ($h instanceof DockerHost) {
                $installed = JobStep::query()->where('job_id', $job->id)->where('op', 'software.install')->where('state', 'succeeded')->exists();
                $h->fill(['state' => $h->enabled ? 'degraded' : ($installed ? 'degraded' : 'not_installed')])->save();
            }

            return;
        }
        if ($job->type === 'registry.test') {
            Registry::withTrashed()->find($job->resource_id)?->fill(['last_test_at' => $now, 'last_test_ok' => false,
                'last_test_message' => mb_substr((string) ($job->error_message ?? $job->state), 0, 500)])->save();

            return;
        }
        $p = $job->resource_type === 'compose_project' ? ComposeProject::withTrashed()->find($job->resource_id) : null;
        if (! $p instanceof ComposeProject) {
            return;
        }
        if (in_array($job->type, ['compose.create', 'compose.update', 'compose.delete', 'compose.up', 'compose.down'], true)) {
            $p->forceFill(['status' => 'failed', 'run_state' => $job->type === 'compose.delete' ? $p->run_state : 'error',
                'observed_at' => $now, 'drift' => ['apply' => mb_substr((string) ($job->error_message ?? $job->state), 0, 200)]])->save();
        }
        if ($job->type === 'compose.update_images') {
            $this->recordImageUpdate($job, $p);
        }
    }

    private function recordImageUpdate(Job $job, ComposeProject $p): void
    {
        $keep = max(1, (int) config('itso.docker.keep_rollbacks', 2));
        foreach ((array) ($this->result($job, 'docker.image.update')['services'] ?? []) as $s) {
            if (! is_array($s) || ($s['state'] ?? 'unchanged') === 'unchanged' || ! is_string($s['rollback_tag'] ?? null)) {
                continue;
            }
            ImageRollback::query()->create(['compose_project_id' => $p->id, 'service' => (string) $s['service'],
                'from_digest' => (string) $s['from_digest'], 'to_digest' => (string) $s['to_digest'], 'rollback_tag' => $s['rollback_tag'],
                'state' => $s['state'] === 'rolled_back' ? 'rolled_back' : 'succeeded',
                'reason' => is_string($s['reason'] ?? null) ? mb_substr($s['reason'], 0, 500) : null,
                'job_id' => $job->id, 'requested_by_user_id' => $job->requested_by_user_id,
                'released_at' => $s['state'] === 'rolled_back' ? Carbon::now() : null]);
            // Chỉ giữ N bản gần nhất mỗi service (agent cũng prune tag cũ); bản cũ hơn đánh dấu hết giữ.
            $old = ImageRollback::query()->where('compose_project_id', $p->id)->where('service', $s['service'])
                ->whereNull('released_at')->orderByDesc('id')->skip($keep)->take(100)->pluck('id');
            ImageRollback::query()->whereIn('id', $old)->update(['released_at' => Carbon::now()]);
        }
    }

    /** @return array<string, mixed> kết quả bước cuối có op cho trước */
    private function result(Job $job, string $op): array
    {
        $res = JobStep::query()->where('job_id', $job->id)->where('op', $op)->orderByDesc('seq')->value('result');

        return is_array($res) ? $res : (is_string($res) ? (array) json_decode($res, true) : []);
    }
}
