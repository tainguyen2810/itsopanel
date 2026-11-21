<?php

declare(strict_types=1);

namespace App\Http\Presenters;

use App\Domain\Web\WebsiteSpec;
use App\Models\Certificate;
use App\Models\HostingAccount;
use App\Models\Server;
use App\Models\Website;
use App\Models\WebsiteDomain;

/** Trình bày Website, WebsiteDomain, WebsiteNginx, WebsitePhp theo common.yaml. */
final class WebPresenter
{
    /** @return array<string, mixed> */
    public function website(Website $w): array
    {
        /** @var HostingAccount $a */
        $a = $w->account;
        /** @var Server $s */
        $s = $w->server;
        $cert = WebsiteSpec::certificate($w);
        $drift = null;
        if (is_array($w->drift)) {
            $drift = array_map(fn ($v): string => is_string($v) ? $v : (string) json_encode($v), $w->drift);
        }

        return ['uuid' => $w->uuid, 'hosting_account' => ['uuid' => $a->uuid, 'username' => $a->username],
            'server' => ['uuid' => $s->uuid, 'name' => $s->name], 'primary_domain' => $w->primary_domain, 'type' => $w->type,
            'document_root' => $w->document_root, 'php_version' => $w->php_version, 'ssl_mode' => $w->ssl_mode,
            'waf_enabled' => (bool) ($w->settings?->waf['enabled'] ?? false),
            'domains_count' => WebsiteDomain::query()->where('website_id', $w->id)->count(),
            'certificate_expires_at' => $cert instanceof Certificate ? $cert->not_after?->toIso8601String() : null,
            'status' => $w->status, 'spec_version' => $w->spec_version, 'observed_version' => $w->observed_version,
            'drift' => $drift === [] ? null : $drift, 'observed_at' => $w->observed_at?->toIso8601String(),
            'created_at' => $w->created_at->toIso8601String(), 'updated_at' => $w->updated_at->toIso8601String()];
    }

    /** @return array<string, mixed> */
    public static function domain(WebsiteDomain $d, Website $w): array
    {
        return ['uuid' => $d->uuid, 'website' => ['uuid' => $w->uuid, 'primary_domain' => $w->primary_domain],
            'name' => $d->name, 'type' => $d->type, 'verified_at' => $d->verified_at?->toIso8601String(),
            'created_at' => $d->created_at->toIso8601String(), 'updated_at' => $d->updated_at->toIso8601String()];
    }

    /** @return array<string, mixed> */
    public static function nginx(Website $w): array
    {
        $n = WebsiteSpec::nginx($w);

        return ['client_max_body_size' => (string) $n['client_max_body_size'], 'http2' => (bool) $n['http2'], 'hsts' => (bool) $n['hsts'],
            'extra_headers' => (object) array_map('strval', (array) $n['extra_headers']),
            'redirects' => array_values(array_map(fn ($r): array => ['from' => (string) $r['from'], 'to' => (string) $r['to'],
                'code' => (string) $r['code']], (array) $n['redirects']))];
    }

    /** @return array<string, mixed> */
    public static function php(Website $w): array
    {
        $p = WebsiteSpec::php($w);

        return ['version' => (string) $p['version'], 'memory_limit' => (string) $p['memory_limit'],
            'max_execution_time' => (int) $p['max_execution_time'], 'upload_max_filesize' => (string) $p['upload_max_filesize'],
            'pm_max_children' => (int) $p['pm_max_children'],
            'disable_functions' => array_values(array_map('strval', (array) $p['disable_functions']))];
    }
}
