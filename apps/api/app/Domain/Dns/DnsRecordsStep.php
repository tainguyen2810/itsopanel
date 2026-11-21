<?php

declare(strict_types=1);

namespace App\Domain\Dns;

use App\Domain\Jobs\PanelStep;
use App\Domain\Jobs\PanelStepFailed;
use App\Infrastructure\Cloudflare\CloudflareError;
use App\Models\DnsRecord;
use App\Models\DnsZone;
use App\Models\Job;

/**
 * Bước panel `dns.records.apply` (D-70): ghi Cloudflare trước, thành công mới cập nhật DB. Lỗi 4xx → job failed,
 * DB giữ nguyên; 5xx/429/mạng → thử lại theo backoff của JobRunner.
 */
final class DnsRecordsStep implements PanelStep
{
    public function run(array $params, Job $job): array
    {
        $z = DnsZone::query()->with('provider')->where('uuid', (string) ($params['zone_uuid'] ?? ''))->first();
        if (! $z instanceof DnsZone || $z->external_id === null) {
            throw new PanelStepFailed('not_found', 'Zone không còn.');
        }
        $action = (string) ($params['action'] ?? '');
        $rec = is_array($params['record'] ?? null) ? $params['record'] : [];
        $row = null;
        if ($action !== 'create') {
            $row = DnsRecord::query()->where('zone_id', $z->id)->where('uuid', (string) ($params['record_uuid'] ?? ''))->first();
            if (! $row instanceof DnsRecord) {
                throw new PanelStepFailed('not_found', 'Bản ghi không còn.');
            }
        }
        $client = DnsService::client($z->provider);
        $body = $rec === [] ? [] : array_merge($rec, ['name' => DnsService::fqdn((string) $rec['name'], $z->name)]);
        try {
            switch ($action) {
                case 'create':
                    $res = $client->create($z->external_id, $body);
                    $row = DnsRecord::query()->create(array_merge($rec, ['zone_id' => $z->id, 'external_id' => (string) ($res['id'] ?? ''),
                        'priority' => $rec['priority'] ?? null]));
                    break;
                case 'update':
                    /** @var DnsRecord $row */
                    $client->update($z->external_id, (string) $row->external_id, $body);
                    $row->fill(array_merge($rec, ['priority' => $rec['priority'] ?? null]))->save();
                    break;
                case 'delete':
                    /** @var DnsRecord $row */
                    $client->delete($z->external_id, (string) $row->external_id);
                    $row->delete();
                    break;
                default:
                    throw new PanelStepFailed('invalid_params', 'action không hợp lệ.');
            }
        } catch (CloudflareError $e) {
            throw new PanelStepFailed($e->retryable ? 'dependency_unavailable' : 'invalid_params', $e->getMessage(), $e->retryable);
        }
        $z->touch();

        return ['action' => $action, 'record_uuid' => $row->uuid];
    }
}
