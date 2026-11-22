<?php

declare(strict_types=1);

namespace App\Domain\WordPress;

use App\Auth\Access;
use App\Domain\Audit\AuditLogger;
use App\Domain\Backup\BackupService;
use App\Domain\Backup\BackupSpec;
use App\Domain\Data\DataSpec;
use App\Domain\Hosting\QuotaService;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Domain\Jobs\Secrets;
use App\Domain\Web\DomainRules;
use App\Domain\Web\PhpCatalog;
use App\Domain\Web\WebsiteService;
use App\Domain\Web\WebsiteSpec;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use App\Models\Website;
use App\Models\WebsiteDomain;
use App\Models\WebsiteSetting;
use App\Models\WordPressComponent;
use App\Models\WordPressSite;
use App\Models\WordPressUpdate;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * WordPress Toolkit (D-99, ADR 0044): mọi thao tác đi qua job wp.* của agent (chạy dưới UID account). Cập nhật luôn có
 * snapshot restic pre-wp-update vào repo backup của account (tính vào quota backup) và tự khôi phục khi lỗi.
 */
final class WordPressService
{
    public const HARDENING = ['file_edit_disabled', 'xmlrpc_blocked', 'php_in_uploads_blocked', 'wp_config_protected',
        'version_hidden', 'salts_rotated'];

    /** Cờ hardening áp ở vhost nginx (nginx.vhost.apply.wp_hardening). */
    public const VHOST_FLAGS = ['xmlrpc_blocked', 'php_in_uploads_blocked'];

    public const TYPES = ['wordpress.install', 'wordpress.scan', 'wordpress.update', 'wordpress.clone_staging', 'wordpress.harden',
        'wordpress.admin_password', 'wordpress.maintenance'];

    public function __construct(
        private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit,
        private readonly QuotaService $quota,
        private readonly AgentClient $agent,
        private readonly BackupService $backups,
        private readonly Access $access,
        private readonly DomainRules $domains,
    ) {}

    // ------------------------------------------------------------------ phạm vi

    /** @return Builder<WordPressSite> */
    public function scope(User $u): Builder
    {
        return WordPressSite::query()->whereIn('wordpress_sites.hosting_account_id', $this->access->accounts($u)->select('hosting_accounts.id'));
    }

    public function find(User $u, string $id): WordPressSite
    {
        $wp = Str::isUuid($id) ? $this->scope($u)->with(['website', 'account'])->where('wordpress_sites.uuid', $id)->first() : null;
        if (! $wp instanceof WordPressSite || $wp->website->trashed()) {
            throw new NotFoundHttpException;
        }

        return $wp;
    }

    public static function path(Website $w): string
    {
        return 'sites/'.$w->primary_domain.'/'.$w->document_root;
    }

    /** @return array<string, mixed> WpSite của agent */
    public static function site(WordPressSite $wp): array
    {
        $w = $wp->website;
        $a = $wp->account;

        return ['account' => DataSpec::acct($a), 'domain' => $w->primary_domain, 'path' => $wp->path,
            'php_version' => $w->php_version ?? PhpCatalog::DEFAULT];
    }

    /** 409 nếu site đang có job WordPress chưa xong. */
    public function ensureIdle(WordPressSite $wp): void
    {
        if (Job::query()->where('resource_type', 'wordpress_site')->where('resource_id', $wp->id)
            ->whereIn('state', WebsiteService::ACTIVE_JOB_STATES)->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'Site đang có tác vụ chạy', 'Chờ tác vụ WordPress hiện tại xong rồi thử lại.');
        }
    }

    private function ensureActive(HostingAccount $a): void
    {
        if ($a->lifecycle_state !== 'active') {
            throw new ApiProblem(409, 'invalid_state_transition', 'Account không hoạt động', "Account đang {$a->lifecycle_state}.");
        }
    }

    // ------------------------------------------------------------------ cài đặt

    /**
     * Cài WordPress vào website PHP: tạo DB + DB user (tính quota gói) rồi wp.install. Trả mật khẩu admin sinh một lần.
     *
     * @param  array<string, mixed>  $in  WordPressInstall
     * @return array{0: WordPressSite, 1: Job, 2: string}
     */
    public function install(User $actor, Website $w, array $in): array
    {
        if ($w->type !== 'php') {
            throw ApiProblem::field('website_uuid', 'Chỉ cài WordPress vào website loại php.');
        }
        if (! in_array($w->status, ['ready', 'degraded'], true)) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Website chưa sẵn sàng', "Website đang {$w->status}.");
        }
        $existing = WordPressSite::withTrashed()->where('website_id', $w->id)->first();
        if ($existing instanceof WordPressSite && ! $existing->trashed()) {
            throw ApiProblem::conflict('Website này đã có WordPress.');
        }
        $password = DataSpec::password();

        return DB::transaction(function () use ($actor, $w, $in, $existing, $password): array {
            /** @var HostingAccount $acc */
            $acc = HostingAccount::query()->lockForUpdate()->findOrFail($w->hosting_account_id);
            $this->ensureActive($acc);
            [$db, $user, $dbSteps] = $this->newDatabase($acc, 'wp');
            $attrs = ['website_id' => $w->id, 'hosting_account_id' => $acc->id, 'path' => self::path($w), 'version' => null,
                'admin_user' => (string) $in['admin_username'], 'multisite' => false, 'state' => 'updating', 'maintenance' => false,
                'hardening' => [], 'staging_of_id' => null, 'checksums_ok' => null, 'database_id' => $db->id, 'deleted_at' => null];
            if ($existing instanceof WordPressSite) {
                $existing->forceFill($attrs)->save();
                $wp = $existing;
                WordPressComponent::query()->where('wordpress_site_id', $wp->id)->delete();
            } else {
                $wp = WordPressSite::query()->create($attrs);
            }
            $wp->setRelation('website', $w)->setRelation('account', $acc);
            $spec = new JobSpec('wordpress.install', $wp, $acc->server_id, 1, 1800);
            foreach ($dbSteps as [$op, $params]) {
                $spec->step($op, $params);
            }
            $spec->step('wp.install', ['site' => self::site($wp), 'url' => 'https://'.$w->primary_domain, 'title' => (string) $in['title'],
                'admin_user' => (string) $in['admin_username'], 'admin_email' => (string) $in['admin_email'],
                'admin_password' => WordPressSecrets::put($password), 'locale' => (string) ($in['locale'] ?? 'vi'),
                'db' => ['engine' => 'mariadb', 'name' => $db->name, 'user' => $user->username,
                    'password' => Secrets::ref('db_user_password', $user->uuid)]])
                ->step('wp.info', ['site' => self::site($wp)]);
            $job = $this->jobs->dispatch($spec, $actor);
            Database::query()->whereKey($db->id)->update(['last_job_id' => $job->id]);
            DatabaseUser::query()->whereKey($user->id)->update(['last_job_id' => $job->id]);
            $this->audit->record('wordpress.install', $wp, ['website' => $w->uuid, 'database' => $db->name,
                'admin_user' => $in['admin_username']], 'success', $acc->server_id, $job->id, $actor);

            return [$wp, $job, $password];
        });
    }

    /**
     * DB + DB user mới cho WordPress (MariaDB, tên `<user>_<prefix><n>`), kiểm quota gói.
     *
     * @return array{0: Database, 1: DatabaseUser, 2: list<array{0: string, 1: array<string, mixed>}>}
     */
    private function newDatabase(HostingAccount $acc, string $prefix): array
    {
        $this->quota->ensureCanAdd($acc, 'databases');
        $limit = (int) ($this->quota->limits($acc)['db_user_limit'] ?? 0);
        if (DatabaseUser::query()->where('hosting_account_id', $acc->id)->count() + 1 > $limit) {
            throw QuotaService::exceeded('db_users', "Đã dùng hết DB user theo gói ($limit).");
        }
        $name = '';
        for ($i = 1; $i < 1000; $i++) {
            $name = substr($acc->username.'_'.$prefix.($i === 1 ? '' : (string) $i), 0, 64);
            if (! Database::withTrashed()->where('server_id', $acc->server_id)->where('name', $name)->exists()
                && ! DatabaseUser::withTrashed()->where('server_id', $acc->server_id)->where('username', $name)->exists()) {
                break;
            }
        }
        $db = Database::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $acc->server_id, 'engine' => 'mariadb',
            'name' => $name, 'charset' => 'utf8mb4', 'status' => 'provisioning', 'size_mb' => 0]);
        $user = DatabaseUser::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $acc->server_id, 'engine' => 'mariadb',
            'username' => $name, 'password_encrypted' => Crypt::encryptString(DataSpec::password()), 'host_pattern' => 'localhost',
            'max_connections' => 10, 'status' => 'provisioning']);
        DB::table('database_grants')->insert(['database_id' => $db->id, 'database_user_id' => $user->id,
            'privileges' => DataSpec::toPgArray(['ALL'])]);
        $a = DataSpec::acct($acc);

        return [$db, $user, [
            ['db.mysql.owner_ensure', ['account' => $a]],
            ['db.mysql.create', ['account' => $a, 'name' => $name, 'charset' => 'utf8mb4']],
            ['db.mysql.user_ensure', ['account' => $a, 'username' => $name, 'password' => Secrets::ref('db_user_password', $user->uuid),
                'host' => 'localhost', 'max_connections' => 10]],
            ['db.mysql.grant', ['account' => $a, 'username' => $name, 'database' => $name, 'privileges' => ['ALL']]],
        ]];
    }

    // ------------------------------------------------------------------ quét

    /** Quét docroot các website PHP trong phạm vi (wp.detect): một job mỗi server; trả job đầu tiên. */
    public function scan(User $actor): Job
    {
        $sites = Website::query()->whereIn('hosting_account_id', $this->access->accounts($actor)->select('hosting_accounts.id'))
            ->where('type', 'php')->whereIn('status', ['ready', 'degraded', 'suspended'])->with('account')->orderBy('id')->get();
        if ($sites->isEmpty()) {
            throw new ApiProblem(409, 'precondition_failed', 'Không có website PHP', 'Chưa có website PHP nào để quét.');
        }
        $first = null;
        foreach ($sites->groupBy('server_id') as $serverId => $list) {
            $server = Server::query()->findOrFail((int) $serverId);
            $spec = new JobSpec('wordpress.scan', null, $server->id, 1, 600);
            foreach ($list->groupBy('hosting_account_id') as $ws) {
                /** @var Website $w0 */
                $w0 = $ws->first();
                $roots = $ws->map(fn (Website $w): string => self::path($w))->unique()->take(200)->values()->all();
                $spec->step('wp.detect', ['account' => DataSpec::acct($w0->account), 'roots' => $roots]);
            }
            $job = $this->jobs->dispatch($spec, $actor);
            $this->audit->record('wordpress.scan', $server, ['websites' => $list->count()], 'success', $server->id, $job->id, $actor);
            $first ??= $job;
        }

        /** @var Job $first */
        return $first;
    }

    // ------------------------------------------------------------------ đọc trạng thái

    /** Làm mới cache từ wp.info (đồng bộ, tối đa mỗi 5 phút; agent không trả lời thì giữ cache). */
    public function refresh(WordPressSite $wp, bool $force = false): void
    {
        if ($wp->state !== 'ok' || (! $force && $wp->last_scan_at !== null && $wp->last_scan_at->gt(Carbon::now()->subMinutes(5)))) {
            return;
        }
        try {
            $r = $this->agent->forServer($wp->website->server_id)->call('wp.info', ['site' => self::site($wp)], null, null, 60.0);
        } catch (AgentUnavailable) {
            return;
        }
        if ($r->ok && is_array($r->data)) {
            self::storeInfo($wp, $r->data);
        }
    }

    /** @param array<string, mixed> $info kết quả wp.info */
    public static function storeInfo(WordPressSite $wp, array $info): void
    {
        $now = Carbon::now();
        $hard = [];
        foreach (self::HARDENING as $k) {
            $hard[$k] = (bool) ($info['hardening'][$k] ?? false);
        }
        $dbId = null;
        if (is_string($info['db_name'] ?? null)) {
            $dbId = Database::query()->where('hosting_account_id', $wp->hosting_account_id)->where('name', $info['db_name'])->value('id');
        }
        $wp->forceFill(['version' => is_string($info['version'] ?? null) ? mb_substr($info['version'], 0, 50) : $wp->version,
            'multisite' => (bool) ($info['multisite'] ?? false), 'maintenance' => (bool) ($info['maintenance'] ?? false),
            'checksums_ok' => is_bool($info['checksums_ok'] ?? null) ? $info['checksums_ok'] : null,
            'hardening' => $hard, 'database_id' => $dbId ?? $wp->database_id, 'last_scan_at' => $now])->save();
        $keep = [];
        foreach ((array) ($info['components'] ?? []) as $c) {
            if (! is_array($c) || ! in_array($c['type'] ?? null, ['core', 'plugin', 'theme'], true)) {
                continue;
            }
            $slug = $c['type'] === 'core' ? null : (is_string($c['slug'] ?? null) ? $c['slug'] : null);
            if ($c['type'] !== 'core' && ($slug === null || preg_match('/^[a-z0-9][a-z0-9_-]{0,99}$/', $slug) !== 1)) {
                continue;
            }
            $row = WordPressComponent::query()->updateOrCreate(['wordpress_site_id' => $wp->id, 'type' => $c['type'], 'slug' => $slug], [
                'name' => mb_substr((string) ($c['name'] ?? $slug ?? 'WordPress'), 0, 200), 'version' => mb_substr((string) ($c['version'] ?? ''), 0, 50),
                'update_version' => is_string($c['update_version'] ?? null) ? mb_substr($c['update_version'], 0, 50) : null,
                'active' => (bool) ($c['active'] ?? true), 'observed_at' => $now]);
            $keep[] = $row->id;
        }
        WordPressComponent::query()->where('wordpress_site_id', $wp->id)->whereNotIn('id', $keep ?: [0])->delete();
    }

    /** @param array<string, mixed> $in WordPressSettings */
    public function settings(User $actor, WordPressSite $wp, array $in): WordPressSite
    {
        $changes = [];
        foreach (['auto_update', 'update_window'] as $k) {
            if (array_key_exists($k, $in) && $in[$k] !== $wp->{$k}) {
                $changes[$k] = ['from' => $wp->{$k}, 'to' => $in[$k]];
                $wp->{$k} = (string) $in[$k];
            }
        }
        if ($changes !== []) {
            if (array_key_exists('update_window', $changes)) {
                $wp->last_auto_update_at = null;
            }
            $wp->save();
            $this->audit->record('wordpress.settings', $wp, $changes, 'success', $wp->website->server_id, null, $actor);
        }

        return $wp->refresh();
    }

    // ------------------------------------------------------------------ cập nhật an toàn

    /**
     * Cập nhật core/plugin/theme: snapshot pre-wp-update (file + DB) → maintenance → update → checksum + http.check →
     * lỗi thì agent khôi phục snapshot. Cần một đích backup; quota backup đang tạm dừng thì từ chối.
     *
     * @param  array<string, mixed>  $in  WordPressUpdateRequest
     */
    public function update(?User $actor, WordPressSite $wp, array $in, string $trigger = 'manual', bool $minorOnly = false): Job
    {
        $comps = [];
        if (($in['core'] ?? false) === true) {
            $comps[] = ['type' => 'core'];
        }
        foreach (['plugins' => 'plugin', 'themes' => 'theme'] as $k => $type) {
            foreach (array_values(array_unique(array_map('strval', (array) ($in[$k] ?? [])))) as $slug) {
                if (preg_match('/^[a-z0-9][a-z0-9_-]{0,99}$/', $slug) !== 1) {
                    throw ApiProblem::field($k, 'Slug không hợp lệ.');
                }
                $comps[] = ['type' => $type, 'slug' => $slug];
            }
        }
        if ($comps === []) {
            throw ApiProblem::field('core', 'Chọn ít nhất một thành phần để cập nhật.');
        }
        if (count($comps) > 200) {
            throw ApiProblem::field('plugins', 'Tối đa 200 thành phần mỗi lượt.');
        }
        $w = $wp->website;
        $acc = $wp->account;
        $this->ensureActive($acc);
        if ($wp->state !== 'ok') {
            throw new ApiProblem(409, 'invalid_state_transition', 'Site chưa sẵn sàng', "Site WordPress đang {$wp->state}.");
        }
        $this->ensureIdle($wp);
        if ($this->backups->quotaState($acc) === 'paused') {
            throw new ApiProblem(409, 'quota_exceeded', 'Vượt quota backup',
                'Cập nhật cần snapshot trước nhưng dung lượng backup của account vượt 120 % quota gói: xóa bớt bản cũ hoặc nâng gói.');
        }
        $dest = $this->backups->destinationsFor($acc)->first();
        if ($dest === null) {
            throw new ApiProblem(409, 'precondition_failed', 'Chưa có đích backup',
                'Cập nhật WordPress luôn chụp snapshot trước: SUPER_ADMIN cần thêm đích backup.');
        }
        $this->backups->ensureIdle($acc);

        return DB::transaction(function () use ($actor, $wp, $w, $acc, $comps, $trigger, $minorOnly, $dest): Job {
            $server = Server::query()->findOrFail($w->server_id);
            $repo = $this->backups->repository($dest, $server, $acc);
            $db = $wp->database_id !== null ? Database::query()->find($wp->database_id) : null;
            $spec = new JobSpec('wordpress.update', $wp, $w->server_id, 1, 3600);
            if ($repo->initialized_at === null) {
                $spec->step('backup.repo.init', ['repo' => BackupSpec::repo($repo)]);
            }
            $cert = WebsiteSpec::certificate($w);
            $spec->step('wp.update', ['site' => self::site($wp), 'components' => $comps, 'minor_only' => $minorOnly,
                'snapshot' => ['repo' => BackupSpec::repo($repo), 'db' => $db instanceof Database ? ['engine' => 'mariadb', 'name' => $db->name] : null,
                    'tags' => ['account:'.$acc->uuid, $trigger === 'auto' ? 'auto' : 'manual']],
                'check_scheme' => $cert !== null ? 'https' : 'http'])
                ->step('backup.stats', ['repo' => BackupSpec::repo($repo)])
                ->step('wp.info', ['site' => self::site($wp)]);
            $job = $this->jobs->dispatch($spec, $actor);
            $versions = WordPressComponent::query()->where('wordpress_site_id', $wp->id)->get()
                ->mapWithKeys(fn (WordPressComponent $c): array => [$c->type.'/'.($c->slug ?? '') => $c->version])->all();
            WordPressUpdate::query()->create(['wordpress_site_id' => $wp->id, 'job_id' => $job->id, 'trigger' => $trigger,
                'items' => array_map(fn (array $c): array => ['type' => $c['type'], 'slug' => $c['slug'] ?? null,
                    'from_version' => (string) ($versions[$c['type'].'/'.($c['slug'] ?? '')] ?? ''), 'to_version' => '', 'ok' => null], $comps),
                'steps' => array_map(fn (string $k): array => ['key' => $k, 'state' => 'pending'], ['snapshot', 'maintenance', 'update', 'verify', 'rollback']),
                'state' => 'running', 'requested_by_user_id' => $actor?->id, 'started_at' => Carbon::now()]);
            $wp->forceFill(['state' => 'updating'] + ($trigger === 'auto' ? ['last_auto_update_at' => Carbon::now()] : []))->save();
            $this->audit->record('wordpress.update', $wp, ['trigger' => $trigger, 'minor_only' => $minorOnly,
                'components' => $comps], 'success', $w->server_id, $job->id, $actor);

            return $job;
        });
    }

    // ------------------------------------------------------------------ staging

    /**
     * Bản staging `<subdomain>.<domain>`: website mới (tính giới hạn website + DB của gói) → DB mới → wp.clone (noindex).
     *
     * @param  array<string, mixed>  $in  WordPressCloneRequest
     */
    public function cloneStaging(User $actor, WordPressSite $wp, array $in): Job
    {
        if (($in['basic_auth'] ?? false) === true) {
            throw ApiProblem::field('basic_auth', 'Bảo vệ staging bằng mật khẩu (basic auth) chưa có ở bản này.');
        }
        $src = $wp->website;
        if ($wp->staging_of_id !== null) {
            throw ApiProblem::conflict('Không tạo staging từ một bản staging.');
        }
        if ($wp->state !== 'ok') {
            throw new ApiProblem(409, 'invalid_state_transition', 'Site chưa sẵn sàng', "Site WordPress đang {$wp->state}.");
        }
        $srcDb = $wp->database_id !== null ? Database::query()->find($wp->database_id) : null;
        if (! $srcDb instanceof Database) {
            throw new ApiProblem(409, 'precondition_failed', 'Chưa biết database của site', 'Mở chi tiết site để làm mới thông tin (DB_NAME) rồi thử lại.');
        }
        $this->ensureIdle($wp);
        $domain = strtolower((string) $in['subdomain']).'.'.$src->primary_domain;
        $this->domains->check($domain, 'subdomain');

        return DB::transaction(function () use ($actor, $wp, $src, $srcDb, $domain, $in): Job {
            /** @var HostingAccount $acc */
            $acc = HostingAccount::query()->lockForUpdate()->findOrFail($wp->hosting_account_id);
            $this->ensureActive($acc);
            $this->quota->ensureCanAdd($acc, 'websites');
            $w = Website::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $acc->server_id, 'primary_domain' => $domain,
                'type' => 'php', 'document_root' => $src->document_root, 'php_version' => $src->php_version, 'ssl_mode' => 'none',
                'status' => 'provisioning', 'spec_version' => 1]);
            WebsiteDomain::query()->create(['website_id' => $w->id, 'name' => $domain, 'type' => 'primary']);
            $srcSettings = WebsiteSetting::query()->where('website_id', $src->id)->first();
            WebsiteSetting::query()->create(['website_id' => $w->id, 'nginx' => WebsiteSpec::NGINX_DEFAULTS,
                'php' => $srcSettings->php ?? WebsiteSpec::PHP_DEFAULTS]);
            $w->load('settings');
            [$db, $user, $dbSteps] = $this->newDatabase($acc, 'stg');
            $stg = WordPressSite::query()->create(['website_id' => $w->id, 'hosting_account_id' => $acc->id, 'path' => self::path($w),
                'version' => $wp->version, 'admin_user' => $wp->admin_user, 'state' => 'cloning', 'auto_update' => 'off',
                'update_window' => $wp->update_window, 'hardening' => [], 'staging_of_id' => $wp->id, 'database_id' => $db->id]);
            $stg->setRelation('website', $w)->setRelation('account', $acc);
            $spec = WebsiteSpec::provision(new JobSpec('wordpress.clone_staging', $stg, $acc->server_id, 1, 3600), $w, $acc);
            foreach ($dbSteps as [$op, $params]) {
                $spec->step($op, $params);
            }
            $spec->step('wp.clone', ['source' => self::site($wp), 'target' => self::site($stg), 'target_url' => 'https://'.$domain,
                'source_db' => $srcDb->name, 'target_db' => ['engine' => 'mariadb', 'name' => $db->name, 'user' => $user->username,
                    'password' => Secrets::ref('db_user_password', $user->uuid)], 'noindex' => ($in['noindex'] ?? true) !== false])
                ->step('wp.info', ['site' => self::site($stg)]);
            $job = $this->jobs->dispatch($spec, $actor);
            Website::query()->whereKey($w->id)->update(['last_job_id' => $job->id]);
            Database::query()->whereKey($db->id)->update(['last_job_id' => $job->id]);
            DatabaseUser::query()->whereKey($user->id)->update(['last_job_id' => $job->id]);
            $this->audit->record('wordpress.clone_staging', $wp, ['staging_domain' => $domain, 'database' => $db->name,
                'noindex' => ($in['noindex'] ?? true) !== false], 'success', $acc->server_id, $job->id, $actor);

            return $job;
        });
    }

    // ------------------------------------------------------------------ hardening, mật khẩu, bảo trì

    /** @param list<string> $items */
    public function harden(User $actor, WordPressSite $wp, array $items, bool $enabled): Job
    {
        $items = array_values(array_unique($items));
        foreach ($items as $it) {
            if (! in_array($it, self::HARDENING, true)) {
                throw ApiProblem::field('items', "Mục hardening không hợp lệ: $it.");
            }
        }
        if (! $enabled && in_array('salts_rotated', $items, true)) {
            throw ApiProblem::field('items', 'Đổi salt không hoàn tác được.');
        }
        $this->ready($wp);

        return DB::transaction(function () use ($actor, $wp, $items, $enabled): Job {
            $w = $wp->website;
            $acc = $wp->account;
            $vhost = array_values(array_intersect($items, self::VHOST_FLAGS));
            if ($vhost !== []) {
                // Cờ vhost là desired state của panel: WebsiteSpec::vhost đọc từ đây mỗi lần áp vhost.
                $h = $wp->hardening;
                foreach ($vhost as $k) {
                    $h[$k] = $enabled;
                }
                $wp->forceFill(['hardening' => $h])->save();
            }
            $spec = (new JobSpec('wordpress.harden', $wp, $w->server_id, 1, 600))
                ->step('wp.harden', ['site' => self::site($wp), 'enable' => $enabled ? $items : [], 'disable' => $enabled ? [] : $items]);
            if ($vhost !== []) {
                $spec->step('nginx.vhost.apply', WebsiteSpec::vhost($w, $acc));
            }
            $spec->step('wp.info', ['site' => self::site($wp)]);
            $job = $this->jobs->dispatch($spec, $actor);
            $this->audit->record('wordpress.harden', $wp, ['items' => $items, 'enabled' => $enabled], 'success', $w->server_id, $job->id, $actor);

            return $job;
        });
    }

    public function adminPassword(User $actor, WordPressSite $wp, string $password): Job
    {
        $password = DataSpec::checkPassword($password);
        if ($wp->admin_user === null || $wp->admin_user === '') {
            throw new ApiProblem(409, 'precondition_failed', 'Chưa biết user admin', 'Site được phát hiện qua quét: panel chưa biết user admin của site này.');
        }
        $this->ready($wp);
        $job = $this->jobs->dispatch((new JobSpec('wordpress.admin_password', $wp, $wp->website->server_id, 1, 300))
            ->step('wp.admin_password', ['site' => self::site($wp), 'user' => $wp->admin_user, 'password' => WordPressSecrets::put($password)]), $actor);
        $this->audit->record('wordpress.admin_password', $wp, ['user' => $wp->admin_user], 'success', $wp->website->server_id, $job->id, $actor);

        return $job;
    }

    public function maintenance(User $actor, WordPressSite $wp, bool $enabled): Job
    {
        $this->ready($wp);
        $job = $this->jobs->dispatch((new JobSpec('wordpress.maintenance', $wp, $wp->website->server_id, 1, 120))
            ->step('wp.maintenance', ['site' => self::site($wp), 'enabled' => $enabled]), $actor);
        $this->audit->record('wordpress.maintenance', $wp, ['enabled' => $enabled], 'success', $wp->website->server_id, $job->id, $actor);

        return $job;
    }

    private function ready(WordPressSite $wp): void
    {
        $this->ensureActive($wp->account);
        if ($wp->state !== 'ok') {
            throw new ApiProblem(409, 'invalid_state_transition', 'Site chưa sẵn sàng', "Site WordPress đang {$wp->state}.");
        }
        $this->ensureIdle($wp);
    }

    // ------------------------------------------------------------------ tự cập nhật (scheduler)

    /** Giờ `$hour` (giờ server) có nằm trong cửa sổ "HH:00-HH:00" không; qua nửa đêm (22:00-02:00) được hỗ trợ. */
    public static function inWindow(string $window, int $hour): bool
    {
        if (preg_match('/^([01][0-9]|2[0-3]):00-([01][0-9]|2[0-3]):00$/', $window, $m) !== 1) {
            return false;
        }
        [$from, $to] = [(int) $m[1], (int) $m[2]];
        if ($from === $to) {
            return true;
        }

        return $from < $to ? $hour >= $from && $hour < $to : $hour >= $from || $hour < $to;
    }

    /**
     * Chạy mỗi giờ: site bật tự cập nhật, đang trong cửa sổ giờ, chưa tự cập nhật trong 20 giờ qua và có bản mới
     * (theo cache wp.info) → job wordpress.update trigger=auto. minor: core + plugin/theme chỉ bản vá (`--minor`).
     *
     * @return int số job đã tạo
     */
    public function autoUpdate(?Carbon $now = null): int
    {
        $now ??= Carbon::now();
        $n = 0;
        $sites = WordPressSite::query()->where('auto_update', '!=', 'off')->where('state', 'ok')->whereNull('staging_of_id')
            ->where(fn ($q) => $q->whereNull('last_auto_update_at')->orWhere('last_auto_update_at', '<', $now->copy()->subHours(20)))
            ->with(['website', 'account'])->orderBy('id')->get();
        foreach ($sites as $wp) {
            if (! self::inWindow($wp->update_window, (int) $now->format('G')) || $wp->website->trashed()) {
                continue;
            }
            $outdated = WordPressComponent::query()->where('wordpress_site_id', $wp->id)->whereNotNull('update_version')->get();
            if ($outdated->isEmpty()) {
                continue;
            }
            $in = ['core' => $outdated->contains('type', 'core'),
                'plugins' => $outdated->where('type', 'plugin')->pluck('slug')->all(),
                'themes' => $outdated->where('type', 'theme')->pluck('slug')->all()];
            try {
                $this->update(null, $wp, $in, 'auto', $wp->auto_update === 'minor');
                $n++;
            } catch (ApiProblem $e) {
                Log::info('wordpress.auto_update bỏ qua', ['site' => $wp->uuid, 'reason' => $e->getMessage()]);
            }
        }

        return $n;
    }

    /**
     * Cờ vhost nginx của website có WordPress (null khi không có site hoặc chưa bật cờ nào).
     *
     * @return array{xmlrpc_blocked: bool, php_in_uploads_blocked: bool}|null
     */
    public static function vhostFlags(Website $w): ?array
    {
        $wp = WordPressSite::query()->where('website_id', $w->id)->first();
        if (! $wp instanceof WordPressSite || $w->type !== 'php') {
            return null;
        }
        $h = $wp->hardening;
        $flags = ['xmlrpc_blocked' => (bool) ($h['xmlrpc_blocked'] ?? false), 'php_in_uploads_blocked' => (bool) ($h['php_in_uploads_blocked'] ?? false)];

        return in_array(true, $flags, true) ? $flags : null;
    }
}
