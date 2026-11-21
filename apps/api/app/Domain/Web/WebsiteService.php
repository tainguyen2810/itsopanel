<?php

declare(strict_types=1);

namespace App\Domain\Web;

use App\Domain\Audit\AuditLogger;
use App\Domain\Hosting\ProvisioningService;
use App\Domain\Hosting\QuotaService;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\Certificate;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\PhpVersion;
use App\Models\User;
use App\Models\Website;
use App\Models\WebsiteDomain;
use App\Models\WebsiteSetting;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Website Service (Prompt 5.3): mọi thay đổi website đi qua đây. Desired state ghi vào DB rồi tạo job áp xuống agent
 * (D-67/D-68): website.create (layout → pool → vhost), website.update/nginx.update/php.update, domain add/remove
 * (áp lại vhost), website.delete (vhost.remove → pool.remove; dữ liệu trong home giữ nguyên).
 */
final class WebsiteService
{
    public const ACTIVE_JOB_STATES = ['queued', 'running', 'cancel_requested', 'waiting_agent'];

    public function __construct(
        private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit,
        private readonly QuotaService $quota,
        private readonly DomainRules $domains,
        private readonly AgentClient $agent,
    ) {}

    /**
     * @param  array<string, mixed>  $in  WebsiteCreate đã qua validate cú pháp
     * @return array{0: Website, 1: Job}
     */
    public function create(User $actor, HostingAccount $a, array $in): array
    {
        $type = (string) $in['type'];
        $domain = strtolower(trim((string) $in['primary_domain']));
        $this->domains->check($domain, 'primary_domain');
        $docRoot = self::documentRoot($in['document_root'] ?? 'public');
        $php = null;
        $proxyPort = null;
        if ($type === 'php') {
            $php = $this->phpVersion($a, $in['php_version'] ?? null);
        } elseif (($in['php_version'] ?? null) !== null) {
            throw ApiProblem::field('php_version', 'Chỉ website loại php mới có phiên bản PHP.');
        }
        if ($type === 'proxy') {
            $proxyPort = self::proxyPort($in['proxy_target'] ?? null);
        } elseif (($in['proxy_target'] ?? null) !== null) {
            throw ApiProblem::field('proxy_target', 'Chỉ website loại proxy mới có proxy_target.');
        }
        $limits = $this->quota->limits($a);
        if (($in['ssl_mode'] ?? 'none') === 'acme') {
            WebsiteSpec::acmeEmail();
            WebsiteSpec::acmeDirectory();
        }

        return DB::transaction(function () use ($actor, $a, $type, $domain, $docRoot, $php, $proxyPort, $in, $limits): array {
            /** @var HostingAccount $acc */
            $acc = HostingAccount::query()->lockForUpdate()->findOrFail($a->id);
            if ($acc->lifecycle_state !== 'active') {
                throw new ApiProblem(409, 'invalid_state_transition', 'Account không hoạt động',
                    "Account đang {$acc->lifecycle_state}: không tạo website mới.");
            }
            $this->quota->ensureCanAdd($acc, 'websites');
            $w = Website::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $acc->server_id,
                'primary_domain' => $domain, 'type' => $type, 'document_root' => $docRoot, 'php_version' => $php,
                'ssl_mode' => (string) ($in['ssl_mode'] ?? 'none'), 'status' => 'provisioning', 'spec_version' => 1]);
            WebsiteDomain::query()->create(['website_id' => $w->id, 'name' => $domain, 'type' => 'primary']);
            $nginx = WebsiteSpec::NGINX_DEFAULTS;
            if ($proxyPort !== null) {
                $nginx['proxy_port'] = $proxyPort;
            }
            $phpSettings = WebsiteSpec::PHP_DEFAULTS;
            $phpSettings['pm_max_children'] = max(1, min(64, (int) $phpSettings['pm_max_children'], (int) ($limits['php_workers_max'] ?? 5)));
            WebsiteSetting::query()->create(['website_id' => $w->id, 'nginx' => $nginx, 'php' => $phpSettings]);
            $w->load('settings');
            $spec = WebsiteSpec::provision(new JobSpec('website.create', $w, $w->server_id, 3, 900), $w, $acc);
            if ($w->ssl_mode === 'acme') {
                CertificateService::appendAcme($spec, $w, $acc, 'none');
            }
            $job = $this->dispatch($spec, $actor, $w);
            $this->audit->record('website.create', $w, ['primary_domain' => $domain, 'type' => $type,
                'hosting_account' => $acc->uuid], 'success', $w->server_id, $job->id, $actor);

            return [$w->refresh(), $job];
        });
    }

    /** @param  array<string, mixed>  $in  WebsiteUpdate */
    public function update(User $actor, Website $w, array $in): Job
    {
        $phpChanged = array_key_exists('php_version', $in) && ($in['php_version'] ?? PhpCatalog::DEFAULT) !== $w->php_version;
        $issue = ($in['ssl_mode'] ?? null) === 'acme' && $w->ssl_mode !== 'acme'
            && ! Certificate::query()->where('website_id', $w->id)->where('source', 'acme')->where('status', 'ready')->exists();
        $prevMode = $w->ssl_mode;
        if ($issue) {
            WebsiteSpec::acmeEmail();
            WebsiteSpec::acmeDirectory();
        }

        return $this->mutate($actor, $w, 'website.update', function (Website $w, HostingAccount $a) use ($in): array {
            $changes = [];
            if (array_key_exists('document_root', $in)) {
                $doc = self::documentRoot($in['document_root']);
                if ($doc !== $w->document_root) {
                    $changes['document_root'] = ['from' => $w->document_root, 'to' => $doc];
                    $w->document_root = $doc;
                }
            }
            if (array_key_exists('php_version', $in)) {
                if ($w->type !== 'php') {
                    throw ApiProblem::field('php_version', 'Chỉ website loại php mới có phiên bản PHP.');
                }
                $v = $this->phpVersion($a, $in['php_version']);
                if ($v !== $w->php_version) {
                    $changes['php_version'] = ['from' => $w->php_version, 'to' => $v];
                    $w->php_version = $v;
                }
            }
            if (array_key_exists('ssl_mode', $in) && $in['ssl_mode'] !== $w->ssl_mode) {
                if ($in['ssl_mode'] === 'custom' && ! Certificate::query()->where('website_id', $w->id)
                    ->where('source', 'upload')->where('status', 'ready')->exists()) {
                    throw ApiProblem::field('ssl_mode', 'Chưa có chứng chỉ tải lên cho website này.');
                }
                $changes['ssl_mode'] = ['from' => $w->ssl_mode, 'to' => $in['ssl_mode']];
                $w->ssl_mode = (string) $in['ssl_mode'];
            }
            if (array_key_exists('waf_enabled', $in)) {
                // WAF hiện thực ở Phase 7: chỉ lưu desired state.
                $s = $this->settings($w);
                $waf = $s->waf;
                if (($waf['enabled'] ?? false) !== (bool) $in['waf_enabled']) {
                    $changes['waf_enabled'] = ['from' => (bool) ($waf['enabled'] ?? false), 'to' => (bool) $in['waf_enabled']];
                    $waf['enabled'] = (bool) $in['waf_enabled'];
                    $s->waf = $waf;
                    $s->save();
                }
            }

            return $changes;
        }, function (JobSpec $spec, Website $w, HostingAccount $a) use ($phpChanged, $issue, $prevMode): JobSpec {
            // Đổi phiên bản PHP → dựng lại pool (socket mới) trước khi vhost trỏ sang.
            if ($phpChanged) {
                $spec->step('php.pool.apply', WebsiteSpec::pool($w, $a));
            }
            if ($issue) {
                // Bật ACME: vhost hiện tại đã phục vụ /.well-known/acme-challenge; cấp xong mới áp vhost có tls.
                CertificateService::appendAcme($spec, $w, $a, $prevMode);

                return $spec;
            }

            return $spec->step('nginx.vhost.apply', WebsiteSpec::vhost($w, $a));
        });
    }

    /** @param  array<string, mixed>  $in  WebsiteNginx (một phần) */
    public function updateNginx(User $actor, Website $w, array $in): Job
    {
        return $this->mutate($actor, $w, 'website.nginx.update', function (Website $w) use ($in): array {
            if (isset($in['redirects'])) {
                $seen = [];
                foreach ((array) $in['redirects'] as $i => $r) {
                    $from = (string) ($r['from'] ?? '');
                    if (isset($seen[$from]) || str_starts_with($from, '/.well-known/acme-challenge/')) {
                        throw ApiProblem::field("redirects.$i.from", 'Đường dẫn trùng hoặc bị cấm.');
                    }
                    $seen[$from] = true;
                }
            }
            if (isset($in['extra_headers'])) {
                if (count((array) $in['extra_headers']) > 20) {
                    throw ApiProblem::field('extra_headers', 'Tối đa 20 header.');
                }
                foreach (array_keys((array) $in['extra_headers']) as $k) {
                    if (preg_match('/^[A-Za-z][A-Za-z0-9-]{1,63}$/', (string) $k) !== 1 || strcasecmp((string) $k, 'Strict-Transport-Security') === 0) {
                        throw ApiProblem::field('extra_headers', "Tên header không hợp lệ: $k (HSTS bật qua trường hsts).");
                    }
                }
            }
            $s = $this->settings($w);
            $old = WebsiteSpec::nginx($w);
            $new = array_merge($old, array_intersect_key($in, WebsiteSpec::NGINX_DEFAULTS));
            $s->nginx = array_merge($s->nginx, $new);
            $s->save();
            $w->setRelation('settings', $s);
            $changes = [];
            foreach ($new as $k => $v) {
                if ($v !== $old[$k]) {
                    $changes[$k] = ['from' => $old[$k], 'to' => $v];
                }
            }

            return $changes;
        }, fn (JobSpec $spec, Website $w, HostingAccount $a): JobSpec => $spec->step('nginx.vhost.apply', WebsiteSpec::vhost($w, $a)));
    }

    /** @param  array<string, mixed>  $in  WebsitePhp (một phần) */
    public function updatePhp(User $actor, Website $w, array $in): Job
    {
        if ($w->type !== 'php') {
            throw new ApiProblem(409, 'invalid_state_transition', 'Website không chạy PHP', 'Chỉ website loại php có cấu hình PHP.');
        }

        return $this->mutate($actor, $w, 'website.php.update', function (Website $w, HostingAccount $a) use ($in): array {
            $limits = $this->quota->limits($a);
            if (isset($in['pm_max_children']) && (int) $in['pm_max_children'] > (int) ($limits['php_workers_max'] ?? 64)) {
                throw QuotaService::exceeded('pm_max_children', 'Gói cho tối đa '.(int) $limits['php_workers_max'].' PHP worker.');
            }
            $changes = [];
            if (isset($in['version'])) {
                $v = $this->phpVersion($a, $in['version']);
                if ($v !== $w->php_version) {
                    $changes['version'] = ['from' => $w->php_version, 'to' => $v];
                    $w->php_version = $v;
                }
            }
            $s = $this->settings($w);
            $old = WebsiteSpec::php($w);
            $patch = array_intersect_key($in, WebsiteSpec::PHP_DEFAULTS);
            if (isset($patch['disable_functions'])) {
                $patch['disable_functions'] = array_values(array_unique(array_map('strval', (array) $patch['disable_functions'])));
                sort($patch['disable_functions']);
                if (count($patch['disable_functions']) > 100) {
                    throw ApiProblem::field('disable_functions', 'Tối đa 100 hàm.');
                }
            }
            $s->php = array_merge($s->php, $patch);
            $s->save();
            $w->setRelation('settings', $s);
            foreach ($patch as $k => $v) {
                if ($v !== ($old[$k] ?? null)) {
                    $changes[$k] = ['from' => $old[$k] ?? null, 'to' => $v];
                }
            }

            return $changes;
        }, fn (JobSpec $spec, Website $w, HostingAccount $a): JobSpec => $spec->step('php.pool.apply', WebsiteSpec::pool($w, $a)));
    }

    /** @return array{0: WebsiteDomain, 1: Job} */
    public function addDomain(User $actor, Website $w, string $name, string $type): array
    {
        $name = strtolower(trim($name));
        $this->domains->check($name);
        if ($type === 'subdomain' && ! str_ends_with($name, '.'.$w->primary_domain)) {
            throw ApiProblem::field('name', "Subdomain phải kết thúc bằng .{$w->primary_domain}.");
        }
        $created = null;
        $job = $this->mutate($actor, $w, 'website.domain.add', function (Website $w, HostingAccount $a) use ($name, $type, &$created): array {
            $limitKey = $type === 'subdomain' ? 'subdomain_limit' : 'alias_domain_limit';
            $types = $type === 'subdomain' ? ['subdomain'] : ['alias', 'redirect'];
            $limit = (int) ($this->quota->limits($a)[$limitKey] ?? 0);
            $used = WebsiteDomain::query()->whereIn('type', $types)
                ->whereIn('website_id', Website::query()->where('hosting_account_id', $a->id)->select('id'))->count();
            if ($used + 1 > $limit) {
                throw QuotaService::exceeded('domains', "Đã dùng $used/$limit ".($type === 'subdomain' ? 'subdomain' : 'domain phụ').' theo gói.');
            }
            $created = WebsiteDomain::query()->create(['website_id' => $w->id, 'name' => $name, 'type' => $type]);
            $w->observed_facts = array_merge($w->observed_facts, ['pending_domain' => ['op' => 'add', 'id' => $created->id]]);

            return ['domain' => ['name' => $name, 'type' => $type]];
        }, fn (JobSpec $spec, Website $w, HostingAccount $a): JobSpec => $spec->step('nginx.vhost.apply', WebsiteSpec::vhost($w, $a)));
        if (! $created instanceof WebsiteDomain) {
            throw new \LogicException('website.domain.add: domain chưa được tạo.');
        }

        return [$created, $job];
    }

    public function removeDomain(User $actor, Website $w, WebsiteDomain $d): Job
    {
        if ($d->type === 'primary' || $d->name === $w->primary_domain) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Không gỡ được domain chính',
                'Domain chính gắn với thư mục site; tạo website mới nếu cần đổi.');
        }

        return $this->mutate($actor, $w, 'website.domain.remove', function (Website $w) use ($d): array {
            $d->delete();
            $w->observed_facts = array_merge($w->observed_facts, ['pending_domain' => ['op' => 'remove', 'id' => $d->id]]);

            return ['domain' => ['name' => $d->name, 'type' => $d->type]];
        }, fn (JobSpec $spec, Website $w, HostingAccount $a): JobSpec => $spec->step('nginx.vhost.apply', WebsiteSpec::vhost($w, $a)));
    }

    public function delete(User $actor, Website $w): Job
    {
        if (Certificate::query()->where('website_id', $w->id)->whereIn('status', ['provisioning'])->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'Đang cấp chứng chỉ', 'Chờ cấp chứng chỉ xong rồi xóa.');
        }

        return $this->mutate($actor, $w, 'website.delete', function (Website $w): array {
            $w->status = 'deleting';

            return ['status' => 'deleting'];
        }, function (JobSpec $spec, Website $w, HostingAccount $a): JobSpec {
            $spec->step('nginx.vhost.remove', ['account' => ProvisioningService::ref($a), 'website_uuid' => $w->uuid]);
            if ($w->type === 'php' || $w->php_version !== null) {
                $spec->step('php.pool.remove', ['account' => ProvisioningService::ref($a), 'website_uuid' => $w->uuid]);
            }
            // Chứng chỉ của site (ACME/tải lên) gỡ sau vhost để không để lại /etc/itso/certs/<uuid> (tiêu chí Phase 5).
            foreach (Certificate::query()->where('website_id', $w->id)->orderBy('id')->get() as $c) {
                $spec->step('cert.remove', ['account' => ProvisioningService::ref($a), 'cert_uuid' => $c->uuid]);
            }

            return $spec;
        }, force: true);
    }

    /**
     * Log của site đọc trực tiếp qua log.tail (không tạo job).
     *
     * @return list<string>
     */
    public function logs(User $actor, Website $w, string $kind, int $lines): array
    {
        $a = $w->account;
        try {
            $res = $this->agent->forServer($a->server_id)->call('log.tail', ['account' => ProvisioningService::ref($a), 'site_dir' => $w->primary_domain,
                'kind' => $kind, 'lines' => max(1, min(500, $lines))], (string) Str::uuid7().':1:1',
                ['user_uuid' => $actor->uuid, 'role' => $actor->roleKey() ?? 'SYSTEM'], 10.0);
        } catch (AgentUnavailable $e) {
            throw new ApiProblem(503, 'agent_unavailable', 'Agent không kết nối', 'Không đọc được log: '.mb_substr($e->getMessage(), 0, 200));
        }
        if (! $res->ok) {
            if (($res->error['code'] ?? '') === 'not_found') {
                return [];
            }
            throw new ApiProblem(503, 'agent_unavailable', 'Không đọc được log', (string) ($res->error['message'] ?? 'Lỗi agent.'));
        }

        return array_values(array_map('strval', (array) ($res->data['lines'] ?? [])));
    }

    /** 409 nếu website hoặc account của nó đang có job chưa xong. */
    public function ensureIdle(Website $w): void
    {
        $a = $w->account;
        foreach ([$w->last_job_id, $a->last_job_id] as $jobId) {
            if ($jobId !== null && Job::query()->whereKey($jobId)->whereIn('state', self::ACTIVE_JOB_STATES)->exists()) {
                throw new ApiProblem(409, 'resource_locked', 'Website đang có tác vụ chạy', 'Chờ tác vụ hiện tại xong rồi thử lại.');
            }
        }
    }

    public static function etag(Website $w): string
    {
        return '"w-'.$w->spec_version.'-'.$w->updated_at->getTimestamp().'"';
    }

    /**
     * @param  callable(Website, HostingAccount): array<string, mixed>  $apply  đổi desired state, trả thay đổi để audit
     * @param  callable(JobSpec, Website, HostingAccount): JobSpec  $steps
     */
    private function mutate(User $actor, Website $w, string $type, callable $apply, callable $steps, bool $force = false): Job
    {
        return DB::transaction(function () use ($actor, $w, $type, $apply, $steps, $force): Job {
            /** @var Website $locked */
            $locked = Website::query()->with('settings')->lockForUpdate()->findOrFail($w->id);
            if (in_array($locked->status, ['deleting', 'pending'], true)) {
                throw new ApiProblem(409, 'invalid_state_transition', 'Website đang bị xóa', 'Không sửa được website đang xóa.');
            }
            if ($locked->status === 'failed' && ! $force) {
                throw new ApiProblem(409, 'invalid_state_transition', 'Website tạo lỗi',
                    'Website tạo không thành công: thử lại job tạo hoặc xóa website.');
            }
            $this->ensureIdle($locked);
            /** @var HostingAccount $a */
            $a = HostingAccount::query()->findOrFail($locked->hosting_account_id);
            $changes = $apply($locked, $a);
            if ($changes === [] && ! $force) {
                throw new ApiProblem(409, 'conflict', 'Không có thay đổi', 'Cấu hình gửi lên giống cấu hình hiện tại.');
            }
            $locked->spec_version++;
            $locked->save();
            $job = $this->dispatch($steps(new JobSpec($type, $locked, $locked->server_id, 3, 600), $locked, $a), $actor, $locked);
            $this->audit->record($type, $locked, $changes, 'success', $locked->server_id, $job->id, $actor);
            $w->setRawAttributes($locked->getAttributes(), true);

            return $job;
        });
    }

    private function dispatch(JobSpec $spec, User $actor, Website $w): Job
    {
        $job = $this->jobs->dispatch($spec, $actor);
        Website::query()->whereKey($w->id)->update(['last_job_id' => $job->id]);
        // Chứng chỉ ACME vừa tạo trong cùng job (website.create/update với ssl_mode = acme).
        Certificate::query()->where('website_id', $w->id)->where('status', 'provisioning')->whereNull('last_job_id')
            ->update(['last_job_id' => $job->id]);
        $w->last_job_id = $job->id;

        return $job;
    }

    private function settings(Website $w): WebsiteSetting
    {
        return WebsiteSetting::query()->firstOrCreate(['website_id' => $w->id],
            ['nginx' => WebsiteSpec::NGINX_DEFAULTS, 'php' => WebsiteSpec::PHP_DEFAULTS]);
    }

    /** PHP chỉ 8.3 (D-68) và phải đã cài trên server của account. */
    private function phpVersion(HostingAccount $a, mixed $v): string
    {
        $v = $v === null ? PhpCatalog::DEFAULT : (string) $v;
        if (! PhpCatalog::supported($v)) {
            throw new ApiProblem(409, 'precondition_failed', 'Phiên bản PHP chưa hỗ trợ',
                'Phase 5 chỉ hỗ trợ PHP 8.3 từ kho Ubuntu 24.04 (D-68).');
        }
        if (! PhpVersion::query()->where('server_id', $a->server_id)->where('version', $v)->where('status', 'ready')->exists()) {
            throw new ApiProblem(409, 'precondition_failed', 'PHP chưa cài trên server',
                "PHP $v chưa cài trên server của account (PHP Manager hoặc wizard bước 4).");
        }

        return $v;
    }

    /** document_root tương đối với thư mục site, phải là public hoặc nằm dưới public/ (ADR 0014). */
    public static function documentRoot(mixed $v): string
    {
        $v = (string) $v;
        $ok = ($v === 'public' || str_starts_with($v, 'public/')) && strlen($v) <= 255 && ! str_ends_with($v, '/')
            && preg_match('/^[A-Za-z0-9._\/-]+$/', $v) === 1;
        foreach (explode('/', $v) as $seg) {
            $ok = $ok && $seg !== '' && $seg !== '.' && $seg !== '..';
        }
        if (! $ok) {
            throw ApiProblem::field('document_root', 'document_root phải là public hoặc thư mục con của public/ (không có .., ký tự đặc biệt).');
        }

        return $v;
    }

    private static function proxyPort(mixed $target): int
    {
        if (! is_string($target) || preg_match('#^http://127\.0\.0\.1:([0-9]{2,5})$#', $target, $m) !== 1
            || (int) $m[1] < 1024 || (int) $m[1] > 65535) {
            throw ApiProblem::field('proxy_target', 'Website proxy cần proxy_target dạng http://127.0.0.1:<cổng 1024–65535>.');
        }

        return (int) $m[1];
    }
}
