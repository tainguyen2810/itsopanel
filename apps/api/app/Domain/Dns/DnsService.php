<?php

declare(strict_types=1);

namespace App\Domain\Dns;

use App\Auth\Access;
use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Cloudflare\CloudflareClient;
use App\Infrastructure\Cloudflare\CloudflareError;
use App\Models\DnsProvider;
use App\Models\DnsRecord;
use App\Models\DnsZone;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;

/**
 * DNS Cloudflare (Prompt 5.4, D-70). Mọi thay đổi ghi Cloudflare trước, thành công mới lưu DB: provider kiểm token
 * khi tạo; zone phải có sẵn trong tài khoản Cloudflare; record đi qua job có bước panel `dns.records.apply`.
 * Phạm vi: SUPER_ADMIN mọi zone; ADMIN chỉ zone gắn account trong phạm vi.
 */
final class DnsService
{
    public const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'];

    public function __construct(
        private readonly Access $access,
        private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit,
    ) {}

    public static function client(DnsProvider $p): CloudflareClient
    {
        $cred = json_decode(Crypt::decryptString($p->credentials_encrypted), true);

        return new CloudflareClient(is_array($cred) ? (string) ($cred['api_token'] ?? '') : '');
    }

    public function createProvider(User $actor, string $name, string $token): DnsProvider
    {
        try {
            $label = (new CloudflareClient($token))->verify();
        } catch (CloudflareError $e) {
            throw $e->retryable
                ? self::upstream($e)
                : ApiProblem::field('api_token', 'Cloudflare từ chối token: '.$e->getMessage());
        }
        $p = DnsProvider::query()->create(['type' => 'cloudflare', 'name' => $name, 'account_label' => $label,
            'credentials_encrypted' => Crypt::encryptString(json_encode(['api_token' => $token], JSON_THROW_ON_ERROR)),
            'created_by_user_id' => $actor->id]);
        $this->audit->record('dns.provider.create', $p, ['name' => $name, 'type' => 'cloudflare'], 'success', null, null, $actor);

        return $p;
    }

    public function deleteProvider(User $actor, DnsProvider $p): void
    {
        if (DnsZone::query()->where('provider_id', $p->id)->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'Provider còn zone', 'Gỡ các zone của provider trước.');
        }
        $this->audit->record('dns.provider.delete', $p, ['name' => $p->name], 'success', null, null, $actor);
        $p->delete();
    }

    /** @return Builder<DnsZone> zone actor được thấy */
    public function zones(User $actor): Builder
    {
        $q = DnsZone::query();

        return $this->access->isSuperAdmin($actor) ? $q
            : $q->whereIn('hosting_account_id', $this->access->accounts($actor)->select('hosting_accounts.id'));
    }

    public function createZone(User $actor, DnsProvider $p, string $name, ?HostingAccount $a): DnsZone
    {
        if ($a === null && ! $this->access->isSuperAdmin($actor)) {
            throw ApiProblem::field('hosting_account_uuid', 'ADMIN chỉ thêm zone gắn với account trong phạm vi.');
        }
        if (DnsZone::query()->where('provider_id', $p->id)->where('name', $name)->exists()) {
            throw ApiProblem::conflict("Zone $name đã có.");
        }
        $client = self::client($p);
        try {
            $id = $client->zoneId($name);
            if ($id === null) {
                throw ApiProblem::field('name', "Zone $name không có trong tài khoản Cloudflare của provider.");
            }
            $remote = $client->records($id);
        } catch (CloudflareError $e) {
            throw $e->retryable ? self::upstream($e) : ApiProblem::field('name', 'Cloudflare: '.$e->getMessage());
        }

        return DB::transaction(function () use ($actor, $p, $name, $a, $id, $remote): DnsZone {
            $z = DnsZone::query()->create(['provider_id' => $p->id, 'name' => $name, 'external_id' => $id,
                'hosting_account_id' => $a?->id]);
            $this->replaceRecords($z, $remote);
            $this->audit->record('dns.zone.create', $z, ['name' => $name, 'hosting_account' => $a?->uuid], 'success', null, null, $actor);

            return $z;
        });
    }

    public function updateZone(User $actor, DnsZone $z, ?HostingAccount $a): DnsZone
    {
        if ($a === null && ! $this->access->isSuperAdmin($actor)) {
            throw ApiProblem::field('hosting_account_uuid', 'ADMIN không bỏ gắn account khỏi zone.');
        }
        $from = $z->account?->uuid;
        $z->hosting_account_id = $a?->id;
        $z->save();
        $this->audit->record('dns.zone.update', $z, ['hosting_account' => ['from' => $from, 'to' => $a?->uuid]], 'success', null, null, $actor);

        return $z->refresh();
    }

    /** Gỡ zone khỏi panel (không xóa gì trên Cloudflare). */
    public function deleteZone(User $actor, DnsZone $z): void
    {
        $this->ensureIdle($z);
        DB::transaction(function () use ($actor, $z): void {
            DnsRecord::query()->where('zone_id', $z->id)->delete();
            $this->audit->record('dns.zone.delete', $z, ['name' => $z->name], 'success', null, null, $actor);
            $z->delete();
        });
    }

    /** Đồng bộ record từ Cloudflare về DB (Cloudflare là nguồn sự thật). */
    public function sync(?User $actor, DnsZone $z): DnsZone
    {
        $this->ensureIdle($z);
        try {
            $remote = self::client($z->provider)->records((string) $z->external_id);
        } catch (CloudflareError $e) {
            throw $e->retryable ? self::upstream($e) : new ApiProblem(409, 'precondition_failed', 'Không đọc được zone', 'Cloudflare: '.$e->getMessage());
        }
        DB::transaction(function () use ($actor, $z, $remote): void {
            $n = $this->replaceRecords($z, $remote);
            if ($actor !== null) {
                $this->audit->record('dns.zone.sync', $z, ['records' => $n], 'success', null, null, $actor);
            }
        });

        return $z->refresh();
    }

    /**
     * @param  array<string, mixed>  $in  DnsRecordInput đã validate cú pháp
     */
    public function createRecord(User $actor, DnsZone $z, array $in): Job
    {
        $rec = DnsRecordRules::normalize($in);

        return $this->dispatch($actor, $z, 'dns.record.create', ['zone_uuid' => $z->uuid, 'action' => 'create', 'record' => $rec],
            ['type' => $rec['type'], 'name' => $rec['name']]);
    }

    /** @param  array<string, mixed>  $patch */
    public function updateRecord(User $actor, DnsZone $z, DnsRecord $r, array $patch): Job
    {
        $cur = ['type' => $r->type, 'name' => $r->name, 'content' => $r->content, 'ttl' => $r->ttl, 'proxied' => $r->proxied];
        if ($r->priority !== null) {
            $cur['priority'] = $r->priority;
        }
        $rec = DnsRecordRules::normalize(array_merge($cur, $patch));
        if ($rec == DnsRecordRules::normalize($cur)) {
            throw new ApiProblem(409, 'conflict', 'Không có thay đổi', 'Bản ghi gửi lên giống bản ghi hiện tại.');
        }

        return $this->dispatch($actor, $z, 'dns.record.update', ['zone_uuid' => $z->uuid, 'action' => 'update',
            'record_uuid' => $r->uuid, 'record' => $rec], ['record' => $r->uuid, 'from' => $cur, 'to' => $rec]);
    }

    public function deleteRecord(User $actor, DnsZone $z, DnsRecord $r): Job
    {
        return $this->dispatch($actor, $z, 'dns.record.delete', ['zone_uuid' => $z->uuid, 'action' => 'delete', 'record_uuid' => $r->uuid],
            ['record' => $r->uuid, 'type' => $r->type, 'name' => $r->name]);
    }

    public static function etag(DnsZone $z): string
    {
        return '"dz-'.substr(hash('sha256', $z->uuid.'|'.$z->updated_at->format('U.u').'|'.($z->hosting_account_id ?? '-')), 0, 16).'"';
    }

    /** FQDN Cloudflare → tên tương đối (`@` = gốc zone). */
    public static function relative(string $fqdn, string $zone): string
    {
        $fqdn = strtolower(rtrim($fqdn, '.'));

        return $fqdn === $zone ? '@' : (str_ends_with($fqdn, '.'.$zone) ? substr($fqdn, 0, -strlen($zone) - 1) : $fqdn);
    }

    public static function fqdn(string $name, string $zone): string
    {
        return $name === '@' ? $zone : $name.'.'.$zone;
    }

    /**
     * @param  list<array<string, mixed>>  $remote
     */
    private function replaceRecords(DnsZone $z, array $remote): int
    {
        $keep = [];
        foreach ($remote as $r) {
            $type = (string) ($r['type'] ?? '');
            $id = (string) ($r['id'] ?? '');
            if (! in_array($type, self::TYPES, true) || $id === '') {
                continue; // loại panel chưa quản lý (HTTPS, SVCB, …): để nguyên trên Cloudflare
            }
            $row = DnsRecord::query()->firstOrNew(['zone_id' => $z->id, 'external_id' => $id]);
            $row->fill(['type' => $type, 'name' => self::relative((string) ($r['name'] ?? ''), $z->name),
                'content' => mb_substr((string) ($r['content'] ?? ''), 0, 2048),
                'ttl' => max(60, min(86400, (int) ($r['ttl'] ?? 300) === 1 ? 300 : (int) ($r['ttl'] ?? 300))),
                'priority' => isset($r['priority']) ? (int) $r['priority'] : null, 'proxied' => (bool) ($r['proxied'] ?? false)])->save();
            $keep[] = $row->id;
        }
        DnsRecord::query()->where('zone_id', $z->id)->whereNotIn('id', $keep ?: [0])->delete();
        $z->touch();

        return count($keep);
    }

    /**
     * @param  array<string, mixed>  $params
     * @param  array<string, mixed>  $changes
     */
    private function dispatch(User $actor, DnsZone $z, string $type, array $params, array $changes): Job
    {
        $this->ensureIdle($z);
        $job = $this->jobs->dispatch((new JobSpec($type, $z, null, 3, 120))->step('dns.records.apply', $params), $actor);
        $this->audit->record($type, $z, $changes, 'success', null, $job->id, $actor);

        return $job;
    }

    private function ensureIdle(DnsZone $z): void
    {
        $busy = Job::query()->where('resource_type', 'dns_zone')->where('resource_id', $z->id)
            ->whereIn('state', ['queued', 'running', 'cancel_requested'])->exists();
        if ($busy) {
            throw new ApiProblem(409, 'resource_locked', 'Đang có job khác', 'Chờ thay đổi DNS trước của zone xong.');
        }
    }

    private static function upstream(CloudflareError $e): ApiProblem
    {
        return new ApiProblem(409, 'precondition_failed', 'Cloudflare lỗi tạm thời', $e->getMessage().' Thử lại sau.');
    }
}
