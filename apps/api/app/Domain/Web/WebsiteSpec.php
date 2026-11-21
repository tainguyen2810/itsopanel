<?php

declare(strict_types=1);

namespace App\Domain\Web;

use App\Domain\Hosting\ProvisioningService;
use App\Domain\Jobs\JobSpec;
use App\Models\Certificate;
use App\Models\HostingAccount;
use App\Models\Website;
use App\Models\WebsiteDomain;
use App\Models\WebsiteSetting;

/**
 * Dựng params op agent từ desired state của website (D-67/D-68). Không chứa bí mật; gọi lại được bất cứ lúc nào
 * (reconcile, suspend áp lại vhost) và luôn cho cùng kết quả với cùng desired state.
 */
final class WebsiteSpec
{
    /** Giá trị mặc định khi tạo site (website_settings). */
    public const NGINX_DEFAULTS = ['client_max_body_size' => '64m', 'http2' => true, 'hsts' => false, 'extra_headers' => [],
        'redirects' => []];

    public const PHP_DEFAULTS = ['memory_limit' => '256m', 'max_execution_time' => 60, 'upload_max_filesize' => '64m',
        'pm_max_children' => 5, 'disable_functions' => ['exec', 'passthru', 'proc_open', 'shell_exec', 'system', 'popen', 'pcntl_exec']];

    /** @return array<string, mixed> */
    public static function nginx(Website $w): array
    {
        $s = $w->settings instanceof WebsiteSetting ? $w->settings->nginx : [];

        return array_merge(self::NGINX_DEFAULTS, array_intersect_key($s, self::NGINX_DEFAULTS));
    }

    /** @return array<string, mixed> */
    public static function php(Website $w): array
    {
        $s = $w->settings instanceof WebsiteSetting ? $w->settings->php : [];

        return array_merge(self::PHP_DEFAULTS, ['version' => $w->php_version ?? PhpCatalog::DEFAULT],
            array_intersect_key($s, self::PHP_DEFAULTS));
    }

    public static function proxyPort(Website $w): ?int
    {
        $p = $w->settings instanceof WebsiteSetting ? ($w->settings->nginx['proxy_port'] ?? null) : null;

        return is_int($p) ? $p : null;
    }

    /** Account bị khóa/chấm dứt → vhost trả trang tạm khóa (ADR 0014 mục 6). */
    public static function suspended(HostingAccount $a): bool
    {
        return $a->lifecycle_state !== 'active';
    }

    /** Chứng chỉ đang dùng của website (ssl_mode ≠ none, trạng thái ready, còn hạn xa nhất). */
    public static function certificate(Website $w): ?Certificate
    {
        if ($w->ssl_mode === 'none') {
            return null;
        }

        return Certificate::query()->where('website_id', $w->id)->where('status', 'ready')
            ->orderByDesc('not_after')->first();
    }

    /** @return array<string, mixed> */
    public static function layout(Website $w, HostingAccount $a): array
    {
        return ['account' => ProvisioningService::ref($a), 'site_dir' => $w->primary_domain];
    }

    /** @return array<string, mixed> */
    public static function pool(Website $w, HostingAccount $a): array
    {
        $php = self::php($w);

        return ['account' => ProvisioningService::ref($a), 'website_uuid' => $w->uuid, 'site_dir' => $w->primary_domain,
            'version' => $php['version'], 'pm_max_children' => (int) $php['pm_max_children'],
            'memory_limit' => (string) $php['memory_limit'], 'max_execution_time' => (int) $php['max_execution_time'],
            'upload_max_filesize' => (string) $php['upload_max_filesize'],
            'disable_functions' => array_values(array_map('strval', (array) $php['disable_functions']))];
    }

    /**
     * @param  bool|null  $suspended  null = theo trạng thái account hiện tại
     * @return array<string, mixed>
     */
    public static function vhost(Website $w, HostingAccount $a, ?bool $suspended = null): array
    {
        $domains = WebsiteDomain::query()->where('website_id', $w->id)->orderBy('id')->get(['name', 'type']);
        $names = [$w->primary_domain];
        $redirects = [];
        foreach ($domains as $d) {
            if ($d->name === $w->primary_domain) {
                continue;
            }
            if ($d->type === 'redirect') {
                $redirects[] = $d->name;
            } else {
                $names[] = $d->name;
            }
        }
        $ng = self::nginx($w);
        $p = ['account' => ProvisioningService::ref($a), 'website_uuid' => $w->uuid, 'site_dir' => $w->primary_domain,
            'type' => $w->type, 'server_names' => $names, 'redirect_names' => $redirects, 'document_root' => $w->document_root,
            'http2' => (bool) $ng['http2'], 'client_max_body_size' => (string) $ng['client_max_body_size'],
            'redirects' => array_values((array) $ng['redirects']), 'suspended' => $suspended ?? self::suspended($a)];
        // jsonb → mảng PHP: object rỗng thành [] (sai schema) nên chỉ gửi khi có header.
        if ((array) $ng['extra_headers'] !== []) {
            $p['extra_headers'] = (array) $ng['extra_headers'];
        }
        if ($w->type === 'proxy') {
            $p['proxy_port'] = self::proxyPort($w);
        }
        $cert = self::certificate($w);
        if ($cert !== null) {
            $p['tls'] = ['cert_uuid' => $cert->uuid, 'hsts' => (bool) $ng['hsts'], 'force_https' => true];
        }

        return $p;
    }

    /** Toàn bộ bước dựng một site từ đầu (tạo mới, reconcile). */
    public static function provision(JobSpec $spec, Website $w, HostingAccount $a, ?bool $suspended = null): JobSpec
    {
        $spec->step('fs.site_layout.ensure', self::layout($w, $a));
        if ($w->type === 'php') {
            $spec->step('php.pool.apply', self::pool($w, $a));
        }

        return $spec->step('nginx.vhost.apply', self::vhost($w, $a, $suspended));
    }

    /**
     * Áp lại vhost mọi website còn hoạt động của account (suspend/unsuspend/terminate/restore).
     */
    public static function reapplyAccount(JobSpec $spec, HostingAccount $a, bool $suspended): JobSpec
    {
        $sites = Website::query()->where('hosting_account_id', $a->id)->whereNotIn('status', ['deleting', 'failed', 'pending'])
            ->orderBy('id')->get();
        foreach ($sites as $w) {
            $spec->step('nginx.vhost.apply', self::vhost($w, $a, $suspended));
        }

        return $spec;
    }
}
