<?php

declare(strict_types=1);

namespace App\Domain\Web;

use App\Domain\Audit\AuditLogger;
use App\Domain\Hosting\ProvisioningService;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Domain\Jobs\Secrets;
use App\Exceptions\ApiProblem;
use App\Models\AcmeAccount;
use App\Models\Certificate;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\User;
use App\Models\Website;
use App\Models\WebsiteDomain;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;

/**
 * Chứng chỉ TLS của website (Prompt 5.4, D-69).
 * - ACME: job cert.issue (lego HTTP-01 trên agent) → nginx.vhost.apply có tls → cert.remove bản cũ.
 * - Tải lên: kiểm PEM, khóa khớp, còn hạn, SAN phủ domain; khóa lưu Crypt(APP_KEY); job cert.install chỉ mang
 *   tham chiếu `{"$secret": "certificate_key:<uuid>"}` do JobRunner thay khi gọi agent.
 * - Gia hạn: cert.issue renew khi còn < 30 ngày (itso:certs-renew hằng ngày). Xóa: bỏ tls khỏi vhost rồi cert.remove.
 */
final class CertificateService
{
    public function __construct(
        private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit,
        private readonly WebsiteService $websites,
    ) {}

    /**
     * @param  list<string>  $domains
     * @return array{0: Certificate, 1: Job}
     */
    public function request(User $actor, Website $w, string $source, array $domains, ?string $certPem = null, ?string $keyPem = null): array
    {
        $domains = $this->domains($w, $domains);
        $email = null;
        $dir = null;
        if ($source === 'upload') {
            $parsed = self::parseUpload((string) $certPem, (string) $keyPem, $domains);
        } else {
            if ($certPem !== null || $keyPem !== null) {
                throw ApiProblem::field('certificate_pem', 'Chỉ gửi PEM khi source = upload.');
            }
            $parsed = null;
            $email = WebsiteSpec::acmeEmail();
            $dir = WebsiteSpec::acmeDirectory();
        }

        return DB::transaction(function () use ($actor, $w, $source, $domains, $parsed, $certPem, $keyPem, $email, $dir): array {
            $site = $this->lockedSite($w);
            /** @var HostingAccount $a */
            $a = HostingAccount::query()->findOrFail($site->hosting_account_id);
            if (WebsiteSpec::suspended($a)) {
                throw new ApiProblem(409, 'invalid_state_transition', 'Account không hoạt động', 'Không cấp chứng chỉ cho account đang khóa.');
            }
            $prevMode = $site->ssl_mode;
            $c = new Certificate(['website_id' => $site->id, 'server_id' => $site->server_id, 'domains' => $domains,
                'source' => $source, 'status' => 'provisioning', 'auto_renew' => $source === 'acme', 'spec_version' => 1]);
            if ($parsed !== null) {
                $c->fill(['issuer' => $parsed['issuer'], 'not_before' => $parsed['not_before'], 'not_after' => $parsed['not_after'],
                    'private_key_encrypted' => Crypt::encryptString(trim((string) $keyPem)."\n"),
                    'observed_facts' => ['prev_ssl_mode' => $prevMode]]);
            } else {
                $acme = AcmeAccount::query()->firstOrCreate(['server_id' => $site->server_id, 'email' => (string) $email,
                    'directory_url' => WebsiteSpec::ACME_DIRECTORIES[(string) $dir]], ['key_location' => 'agent']);
                $c->fill(['acme_account_id' => $acme->id, 'observed_facts' => ['prev_ssl_mode' => $prevMode, 'email' => $email,
                    'directory' => $dir]]);
            }
            $c->save();
            $site->ssl_mode = $source === 'upload' ? 'custom' : 'acme';
            $site->spec_version++;
            $site->save();

            $spec = new JobSpec($source === 'upload' ? 'certificate.upload' : 'certificate.issue', $site, $site->server_id, 2, 900);
            $source === 'upload'
                ? $spec->step('cert.install', ['account' => ProvisioningService::ref($a), 'website_uuid' => $site->uuid,
                    'cert_uuid' => $c->uuid, 'certificate_pem' => trim((string) $certPem)."\n",
                    'private_key_pem' => Secrets::ref('certificate_key', $c->uuid)])
                : $spec->step('cert.issue', WebsiteSpec::certIssue($site, $a, $c, false));
            $spec->step('nginx.vhost.apply', WebsiteSpec::vhost($site, $a, null, $c));
            self::retireOthers($spec, $site, $a, $c);
            $job = $this->dispatch($spec, $actor, $c, $site);
            $this->audit->record('certificate.'.($source === 'upload' ? 'upload' : 'issue'), $c,
                ['website' => $site->uuid, 'domains' => $domains, 'source' => $source], 'success', $site->server_id, $job->id, $actor);

            return [$c->refresh(), $job];
        });
    }

    /** Các bước cert.issue + vhost tls khi website được tạo/sửa với ssl_mode = acme (WebsiteService). */
    public static function appendAcme(JobSpec $spec, Website $w, HostingAccount $a, string $prevMode): Certificate
    {
        $email = WebsiteSpec::acmeEmail();
        $dir = WebsiteSpec::acmeDirectory();
        $names = WebsiteDomain::query()->where('website_id', $w->id)->whereIn('type', ['primary', 'alias', 'redirect', 'subdomain'])
            ->orderBy('id')->pluck('name')->all();
        $acme = AcmeAccount::query()->firstOrCreate(['server_id' => $w->server_id, 'email' => $email,
            'directory_url' => WebsiteSpec::ACME_DIRECTORIES[$dir]], ['key_location' => 'agent']);
        $c = Certificate::query()->create(['website_id' => $w->id, 'server_id' => $w->server_id,
            'domains' => array_values(array_unique(array_merge([$w->primary_domain], array_map('strval', $names)))),
            'source' => 'acme', 'status' => 'provisioning', 'auto_renew' => true, 'acme_account_id' => $acme->id,
            'observed_facts' => ['prev_ssl_mode' => $prevMode, 'email' => $email, 'directory' => $dir]]);
        $spec->step('cert.issue', WebsiteSpec::certIssue($w, $a, $c, false));
        $spec->step('nginx.vhost.apply', WebsiteSpec::vhost($w, $a, null, $c));
        self::retireOthers($spec, $w, $a, $c);

        return $c;
    }

    public function renew(?User $actor, Certificate $c): Job
    {
        if ($c->source !== 'acme') {
            throw new ApiProblem(422, 'validation_failed', 'Không gia hạn được chứng chỉ tải lên',
                'Chứng chỉ tải lên: tải bản mới thay thế.', ['source' => ['Chỉ chứng chỉ ACME gia hạn được.']]);
        }

        return DB::transaction(function () use ($actor, $c): Job {
            /** @var Certificate $cert */
            $cert = Certificate::query()->lockForUpdate()->findOrFail($c->id);
            if ($cert->status !== 'ready') {
                throw new ApiProblem(409, 'invalid_state_transition', 'Chứng chỉ chưa sẵn sàng', "Chứng chỉ đang {$cert->status}.");
            }
            $this->ensureIdle($cert);
            $w = Website::query()->find($cert->website_id);
            if (! $w instanceof Website) {
                throw new ApiProblem(409, 'invalid_state_transition', 'Website đã xóa', 'Chứng chỉ không còn website.');
            }
            /** @var HostingAccount $a */
            $a = HostingAccount::query()->withTrashed()->findOrFail($w->hosting_account_id);
            $cert->last_renew_attempt_at = Carbon::now();
            $cert->save();
            $spec = (new JobSpec('certificate.renew', $cert, $cert->server_id, 2, 900))
                ->step('cert.issue', WebsiteSpec::certIssue($w, $a, $cert, true));
            $job = $this->dispatch($spec, $actor, $cert, null);
            $this->audit->record('certificate.renew', $cert, ['not_after' => $cert->not_after?->toIso8601String()], 'success',
                $cert->server_id, $job->id, $actor);

            return $job;
        });
    }

    public function delete(User $actor, Certificate $c): Job
    {
        return DB::transaction(function () use ($actor, $c): Job {
            /** @var Certificate $cert */
            $cert = Certificate::query()->lockForUpdate()->findOrFail($c->id);
            if ($cert->status === 'deleting') {
                throw new ApiProblem(409, 'invalid_state_transition', 'Đang xóa', 'Chứng chỉ đang được xóa.');
            }
            $this->ensureIdle($cert);
            $w = Website::query()->find($cert->website_id);
            $a = $w instanceof Website ? HostingAccount::query()->withTrashed()->find($w->hosting_account_id) : null;
            if (! $a instanceof HostingAccount) {
                throw new ApiProblem(409, 'invalid_state_transition', 'Website đã xóa', 'Chứng chỉ không còn website.');
            }
            $spec = new JobSpec('certificate.delete', $cert, $cert->server_id, 3, 600);
            /** @var Website $w */
            $inUse = WebsiteSpec::certificate($w)?->id === $cert->id;
            if ($inUse) {
                // Chứng chỉ đang phục vụ: bỏ tls khỏi vhost trước (agent từ chối xóa chứng chỉ còn được tham chiếu).
                $site = $this->lockedSite($w, true);
                $site->ssl_mode = 'none';
                $site->spec_version++;
                $site->save();
                $spec->step('nginx.vhost.apply', WebsiteSpec::vhost($site, $a, null, false));
                $w = $site;
            }
            $spec->step('cert.remove', ['account' => ProvisioningService::ref($a), 'cert_uuid' => $cert->uuid]);
            $cert->observed_facts = array_merge($cert->observed_facts, ['prev_status' => $cert->status,
                'prev_ssl_mode' => $inUse ? ($cert->source === 'upload' ? 'custom' : 'acme') : null]);
            $cert->status = 'deleting';
            $cert->save();
            $job = $this->dispatch($spec, $actor, $cert, $inUse ? $w : null);
            $this->audit->record('certificate.delete', $cert, ['domains' => $cert->domains], 'success', $cert->server_id, $job->id, $actor);

            return $job;
        });
    }

    /**
     * Chứng chỉ ACME cần gia hạn: ready, auto_renew, hết hạn trong N ngày, website còn, không có job đang chạy.
     *
     * @return list<Certificate>
     */
    public function due(): array
    {
        $before = Carbon::now()->addDays((int) config('itso.acme.renew_before_days', 30));

        return array_values(Certificate::query()->where('source', 'acme')->where('status', 'ready')->where('auto_renew', true)
            ->where('not_after', '<', $before)
            ->whereIn('website_id', Website::query()->whereNotIn('status', ['deleting', 'failed'])->select('id'))
            ->where(fn ($q) => $q->whereNull('last_job_id')->orWhereNotIn('last_job_id',
                Job::query()->whereIn('state', WebsiteService::ACTIVE_JOB_STATES)->select('id')))
            ->orderBy('not_after')->get()->all());
    }

    /**
     * Kiểm chứng chỉ tải lên (không chạy lệnh: dùng phần mở rộng openssl của PHP).
     *
     * @param  list<string>  $domains
     * @return array{issuer: string, not_before: Carbon, not_after: Carbon}
     */
    public static function parseUpload(string $certPem, string $keyPem, array $domains): array
    {
        if (strlen($certPem) > 65536 || ! str_starts_with(ltrim($certPem), '-----BEGIN CERTIFICATE-----')) {
            throw ApiProblem::field('certificate_pem', 'Cần chuỗi PEM bắt đầu bằng -----BEGIN CERTIFICATE----- (tối đa 64 KB).');
        }
        if (strlen($keyPem) > 16384 || preg_match('/^-----BEGIN (EC |RSA )?PRIVATE KEY-----/', ltrim($keyPem)) !== 1) {
            throw ApiProblem::field('private_key_pem', 'Cần khóa riêng PEM không mã hóa (PRIVATE KEY, RSA hoặc EC; tối đa 16 KB).');
        }
        $x = @openssl_x509_read($certPem);
        if ($x === false) {
            throw ApiProblem::field('certificate_pem', 'Không đọc được chứng chỉ.');
        }
        $k = @openssl_pkey_get_private($keyPem);
        if ($k === false) {
            throw ApiProblem::field('private_key_pem', 'Không đọc được khóa riêng.');
        }
        if (! openssl_x509_check_private_key($x, $k)) {
            throw ApiProblem::field('private_key_pem', 'Khóa riêng không khớp chứng chỉ.');
        }
        $info = openssl_x509_parse($x);
        if (! is_array($info)) {
            throw ApiProblem::field('certificate_pem', 'Không đọc được thông tin chứng chỉ.');
        }
        $from = Carbon::createFromTimestampUTC((int) $info['validFrom_time_t']);
        $to = Carbon::createFromTimestampUTC((int) $info['validTo_time_t']);
        if ($to->isPast()) {
            throw ApiProblem::field('certificate_pem', 'Chứng chỉ đã hết hạn ('.$to->toDateString().').');
        }
        if ($from->isFuture()) {
            throw ApiProblem::field('certificate_pem', 'Chứng chỉ chưa có hiệu lực.');
        }
        $sans = [];
        foreach (explode(',', (string) ($info['extensions']['subjectAltName'] ?? '')) as $part) {
            $part = trim($part);
            if (str_starts_with($part, 'DNS:')) {
                $sans[] = strtolower(substr($part, 4));
            }
        }
        $missing = array_values(array_filter($domains, fn (string $d): bool => ! self::covered($d, $sans)));
        if ($missing !== []) {
            throw ApiProblem::field('domains', 'SAN của chứng chỉ không phủ: '.implode(', ', $missing).'.');
        }
        $issuer = $info['issuer']['O'] ?? $info['issuer']['CN'] ?? 'Không rõ';

        return ['issuer' => mb_substr(is_array($issuer) ? implode(' ', $issuer) : (string) $issuer, 0, 500),
            'not_before' => $from, 'not_after' => $to];
    }

    /** @param  list<string>  $sans */
    private static function covered(string $domain, array $sans): bool
    {
        foreach ($sans as $s) {
            if ($s === $domain) {
                return true;
            }
            // Wildcard chỉ phủ đúng một nhãn: *.anphat.vn phủ www.anphat.vn, không phủ anphat.vn hay a.b.anphat.vn.
            if (str_starts_with($s, '*.') && substr_count($domain, '.') === substr_count($s, '.')
                && str_ends_with($domain, substr($s, 1))) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  list<string>  $domains
     * @return list<string>
     */
    private function domains(Website $w, array $domains): array
    {
        $domains = array_values(array_unique(array_map(fn ($d): string => strtolower(trim((string) $d)), $domains)));
        $attached = WebsiteDomain::query()->where('website_id', $w->id)->pluck('name')->all();
        foreach ($domains as $i => $d) {
            if (! in_array($d, $attached, true)) {
                throw ApiProblem::field("domains.$i", "Domain $d chưa gắn với website (thêm domain trước).");
            }
        }

        return $domains;
    }

    /** Bản cũ cùng website (khác chứng chỉ mới) sẽ được gỡ sau khi vhost chuyển sang bản mới. */
    private static function retireOthers(JobSpec $spec, Website $w, HostingAccount $a, Certificate $new): void
    {
        $old = Certificate::query()->where('website_id', $w->id)->where('id', '!=', $new->id)
            ->whereIn('status', ['ready', 'failed'])->orderBy('id')->get();
        foreach ($old as $o) {
            $spec->step('cert.remove', ['account' => ProvisioningService::ref($a), 'cert_uuid' => $o->uuid]);
            $o->observed_facts = array_merge($o->observed_facts, ['retired_by' => $new->uuid]);
            $o->save();
        }
    }

    private function lockedSite(Website $w, bool $allowFailed = false): Website
    {
        /** @var Website $site */
        $site = Website::query()->with('settings')->lockForUpdate()->findOrFail($w->id);
        if (in_array($site->status, ['deleting', 'pending', 'provisioning'], true) || (! $allowFailed && $site->status === 'failed')) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Website chưa sẵn sàng', "Website đang {$site->status}.");
        }
        $this->websites->ensureIdle($site);

        return $site;
    }

    private function ensureIdle(Certificate $c): void
    {
        if ($c->last_job_id !== null && Job::query()->whereKey($c->last_job_id)->whereIn('state', WebsiteService::ACTIVE_JOB_STATES)->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'Đang có job khác', 'Chứng chỉ đang được cấp/gia hạn/xóa.');
        }
    }

    private function dispatch(JobSpec $spec, ?User $actor, Certificate $c, ?Website $w): Job
    {
        $job = $this->jobs->dispatch($spec, $actor);
        Certificate::query()->whereKey($c->id)->update(['last_job_id' => $job->id]);
        $c->last_job_id = $job->id;
        if ($w !== null) {
            Website::query()->whereKey($w->id)->update(['last_job_id' => $job->id]);
            $w->last_job_id = $job->id;
        }

        return $job;
    }
}
