<?php

declare(strict_types=1);

namespace App\Http\Presenters;

use App\Models\DnsProvider;
use App\Models\DnsRecord;
use App\Models\DnsZone;
use App\Models\HostingAccount;

/** Trình bày DnsProvider, DnsZone, DnsRecord theo hợp đồng (token không bao giờ trả ra). */
final class DnsPresenter
{
    /** @return array<string, mixed> */
    public static function provider(DnsProvider $p): array
    {
        return ['uuid' => $p->uuid, 'type' => $p->type, 'name' => $p->name,
            'zones_count' => DnsZone::query()->where('provider_id', $p->id)->count(), 'account_label' => $p->account_label,
            'created_at' => $p->created_at->toIso8601String(), 'updated_at' => $p->updated_at->toIso8601String()];
    }

    /** @return array<string, mixed> */
    public static function zone(DnsZone $z): array
    {
        $a = $z->account;

        return ['uuid' => $z->uuid, 'name' => $z->name, 'provider' => $z->provider->type,
            'hosting_account' => $a instanceof HostingAccount ? ['uuid' => $a->uuid, 'username' => $a->username] : null,
            'records_count' => DnsRecord::query()->where('zone_id', $z->id)->count(),
            'created_at' => $z->created_at->toIso8601String(), 'updated_at' => $z->updated_at->toIso8601String()];
    }

    /** @return array<string, mixed> */
    public static function record(DnsRecord $r): array
    {
        $out = ['uuid' => $r->uuid, 'type' => $r->type, 'name' => $r->name, 'content' => $r->content, 'ttl' => $r->ttl,
            'proxied' => $r->proxied];
        if ($r->priority !== null) {
            $out['priority'] = $r->priority;
        }

        return $out;
    }
}
