<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use App\Domain\Jobs\JobHandler;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\PhpVersion;
use App\Models\Server;
use App\Models\ServerSoftware;
use Illuminate\Support\Carbon;

/**
 * Ghi observed state khi job software.install/remove/upgrade hoặc software.os_updates kết thúc. Recipe php<ver> cài qua
 * Software Manager cũng phản chiếu sang php_versions để PHP Manager và chọn PHP cho website thấy ngay.
 */
final class SoftwareJobHandler implements JobHandler
{
    public function succeeded(Job $job): void
    {
        $res = $this->result($job);
        if ($job->type === 'software.os_updates') {
            $s = Server::query()->find($job->server_id);
            if ($s instanceof Server) {
                $cur = OsUpdates::get($s);
                OsUpdates::put($s, array_merge($cur, ['enabled' => (bool) ($res['enabled'] ?? $cur['enabled']),
                    'security_only' => (bool) ($res['security_only'] ?? $cur['security_only'])]), $job->requested_by_user_id);
            }

            return;
        }
        $row = $this->row($job);
        if ($row === null) {
            return;
        }
        $installed = $job->type !== 'software.remove' && ($res['installed'] ?? true) !== false;
        $version = $installed ? (is_string($res['version'] ?? null) ? $res['version'] : $row->version) : null;
        $up = $installed && $row->latest_version !== null && $version !== null && $row->latest_version !== $version;
        $row->fill([
            'status' => 'ready', 'version' => $version, 'upgrade_available' => $up,
            'state' => $installed ? ($up ? 'upgradable' : 'installed') : 'available',
            'observed_version' => $row->spec_version, 'observed_at' => Carbon::now(), 'drift' => null,
            'observed_facts' => ['installed' => $installed, 'changed' => (bool) ($res['changed'] ?? false)],
        ])->save();
        if (preg_match('/^php(\d\.\d)$/', $row->software_key, $m) === 1) {
            $php = PhpVersion::query()->firstOrNew(['server_id' => $row->server_id, 'version' => $m[1]]);
            if ($installed) {
                $php->fill(['status' => 'ready', 'observed_at' => Carbon::now()]);
                if (! $php->exists) {
                    $php->extensions = [];
                }
                $php->save();
            } elseif ($php->exists) {
                $php->delete();
            }
        }
    }

    public function failed(Job $job): void
    {
        if ($job->type === 'software.os_updates') {
            return;
        }
        $row = $this->row($job);
        $row?->fill(['status' => 'failed', 'state' => 'failed', 'observed_at' => Carbon::now(),
            'drift' => ['apply' => mb_substr((string) ($job->error_message ?? $job->state), 0, 200)]])->save();
    }

    /** @return array<string, mixed> */
    private function result(Job $job): array
    {
        $res = JobStep::query()->where('job_id', $job->id)->orderByDesc('seq')->value('result');

        return is_array($res) ? $res : (is_string($res) ? (array) json_decode($res, true) : []);
    }

    private function row(Job $job): ?ServerSoftware
    {
        return ServerSoftware::query()->where('last_job_id', $job->id)->lockForUpdate()->first();
    }
}
