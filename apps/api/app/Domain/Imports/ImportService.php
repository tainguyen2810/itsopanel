<?php

declare(strict_types=1);

namespace App\Domain\Imports;

use App\Domain\Audit\AuditLogger;
use App\Domain\Data\DataSpec;
use App\Domain\Hosting\ProvisioningService;
use App\Domain\Hosting\QuotaService;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Domain\Jobs\Secrets;
use App\Domain\Users\UserService;
use App\Domain\Web\CertificateService;
use App\Domain\Web\PhpCatalog;
use App\Domain\Web\WebsiteSpec;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\ServerPresenter;
use App\Models\Agent;
use App\Models\Certificate;
use App\Models\CronJob;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\ImportItem;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\PanelImport;
use App\Models\PhpVersion;
use App\Models\Server;
use App\Models\User;
use App\Models\Website;
use App\Models\WebsiteDomain;
use App\Models\WebsiteSetting;
use Illuminate\Database\QueryException;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;

/**
 * Import từ panel khác trên cùng máy (Phase 12, D-108, ADR 0053). Chỉ SUPER_ADMIN.
 *
 *   scan  → job `import.scan` (op chỉ đọc) → ImportJobHandler lưu kế hoạch (import_items) → planned.
 *   plan  → chọn mục, map username/gói/USER; kiểm trùng domain/username, hạn mức gói (422 theo từng mục).
 *   run   → mỗi username một job `import.run`: account.ensure → quota → mỗi site: layout → import.copy (uid account)
 *           → pool PHP → vhost → DB: tạo DB + user (mật khẩu sinh ở panel, chỉ đi qua tham chiếu bí mật) →
 *           import.db_dump → db.mysql.import → xóa file dump. Cron tạo ở trạng thái tắt (đường dẫn cũ cần kiểm).
 *           Site nguồn vẫn chạy (vhost nguồn chưa đổi).
 *   cutover → job `import.cutover`: đổi tên vhost nguồn (nginx -t, hoàn tác khi lỗi) rồi xin chứng chỉ ACME cho site
 *           có SSL ở nguồn (lúc này domain mới về vhost ITSO). rollback → job `import.rollback`, account ITSO giữ nguyên.
 */
final class ImportService
{
    public const TYPES = ['import.scan', 'import.run', 'import.cutover', 'import.rollback'];

    public const SOURCES = ['aapanel', 'hestia', 'nginx'];

    private const ACTIVE_JOB = ['queued', 'running', 'cancel_requested', 'waiting_agent'];

    /** Thư mục site ITSO chứa file chép từ nguồn (document_root = public/site). */
    public const DOC_ROOT = 'public/site';

    public function __construct(
        private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit,
        private readonly ProvisioningService $provisioning,
        private readonly QuotaService $quota,
        private readonly UserService $users,
    ) {}

    // ------------------------------------------------------------------ scan

    public function scan(User $actor, string $source, Server $server, ?string $idempotencyKey = null): Job
    {
        $agent = Agent::query()->where('server_id', $server->id)->first();
        $conn = $agent instanceof Agent ? ServerPresenter::connection($agent) : 'pending';
        if ($conn !== 'online') {
            throw new ApiProblem(409, 'agent_unreachable', 'Server không kết nối', "{$server->name} đang $conn: không quét được.");
        }
        try {
            return DB::transaction(function () use ($actor, $source, $server, $idempotencyKey): Job {
                $this->ensureNotBusy($server);
                $imp = PanelImport::query()->create(['source' => $source, 'server_id' => $server->id, 'state' => 'scanning',
                    'created_by_user_id' => $actor->id]);
                $spec = (new JobSpec('import.scan', $imp, $server->id, 1, 600))
                    ->step('import.scan', ['source' => $source, 'max_sites' => 500]);
                $job = $this->jobs->dispatch($spec, $actor, $idempotencyKey);
                PanelImport::query()->whereKey($imp->id)->whereNull('scan_job_id')->update(['scan_job_id' => $job->id]);
                $this->audit->record('import.scan', $imp, ['source' => $source, 'server' => $server->name], 'success', $server->id, $job->id, $actor);

                return $job;
            });
        } catch (QueryException $e) {
            if (str_contains($e->getMessage(), 'imports_busy_uq')) {
                throw ApiProblem::conflict("Đang có lượt import khác quét/chạy trên {$server->name}.");
            }
            throw $e;
        }
    }

    private function ensureNotBusy(Server $server): void
    {
        if (PanelImport::query()->where('server_id', $server->id)->whereIn('state', PanelImport::BUSY)->lockForUpdate()->exists()) {
            throw ApiProblem::conflict("Đang có lượt import khác quét/chạy trên {$server->name}.");
        }
    }

    /** Quét xong: lưu từng site thành mục kế hoạch, thêm cảnh báo phía panel (trùng domain/username, DB lớn). */
    public function scanned(PanelImport $imp, Job $job): void
    {
        $step = JobStep::query()->where('job_id', $job->id)->where('op', 'import.scan')->where('state', 'succeeded')->first();
        $res = $step instanceof JobStep && is_array($step->result) ? $step->result : [];
        $taken = [];
        foreach ((array) ($res['sites'] ?? []) as $s) {
            $domain = strtolower((string) $s['domain']);
            $notAfter = $s['ssl']['not_after'] ?? null;
            $ssl = ($s['ssl']['cert_path'] ?? null) === null ? 'none'
                : ($notAfter !== null && Carbon::parse((string) $notAfter)->isFuture() ? 'valid' : 'expired');
            $warnings = array_values(array_map(fn (array $w): array => ['code' => (string) $w['code'], 'message' => mb_substr((string) $w['message'], 0, 500)],
                (array) ($s['warnings'] ?? [])));
            if (WebsiteDomain::query()->whereIn('name', array_merge([$domain], (array) $s['aliases']))->exists()) {
                $warnings[] = ['code' => 'domain_exists', 'message' => "Domain $domain (hoặc alias) đã gắn với website ITSO: không import được mục này."];
            }
            $dbs = array_values(array_map(fn (array $d): array => ['name' => (string) $d['name'], 'size_bytes' => (int) $d['size_bytes']],
                (array) ($s['databases'] ?? [])));
            if (collect($dbs)->contains(fn (array $d): bool => $d['size_bytes'] > 2 * 1024 ** 3)) {
                $warnings[] = ['code' => 'db_large', 'message' => 'Có database lớn hơn 2 GB: dump/import mất nhiều thời gian.'];
            }
            $username = $this->suggestUsername((string) $s['system_user'], $domain, $imp->server_id, $taken);
            $taken[] = $username;
            ImportItem::query()->updateOrCreate(['import_id' => $imp->id, 'domain' => $domain], [
                'aliases' => array_values(array_map('strval', (array) $s['aliases'])), 'docroot' => (string) $s['docroot'],
                'vhost_path' => (string) $s['vhost_path'], 'php_version' => $s['php_version'] ?? null,
                'ssl' => ['cert_path' => $s['ssl']['cert_path'] ?? null, 'not_after' => $notAfter, 'state' => $ssl],
                'size_bytes' => (int) $s['size_bytes'], 'databases' => $dbs,
                'crons' => array_values(array_map(fn (array $c): array => ['schedule' => (string) $c['schedule'], 'command' => (string) $c['command']],
                    (array) ($s['crons'] ?? []))),
                'system_user' => (string) $s['system_user'], 'warnings' => $warnings,
                'selected' => ! collect($warnings)->contains(fn (array $w): bool => $w['code'] === 'domain_exists'),
                'target_username' => $username, 'state' => 'pending', 'progress' => 0,
            ]);
        }
        $imp->forceFill(['state' => 'planned', 'source_version' => $res['source_version'] ?? null, 'scanned_at' => Carbon::now(),
            'error' => ($res['truncated'] ?? false) ? 'Nguồn có hơn 500 website: chỉ lấy 500 mục đầu.' : null])->save();
    }

    /** @param  list<string>  $taken */
    private function suggestUsername(string $systemUser, string $domain, int $serverId, array $taken): string
    {
        $base = preg_match('/^[a-z][a-z0-9]{2,15}$/', $systemUser) === 1 && ! in_array($systemUser, ProvisioningService::RESERVED, true)
            ? $systemUser : substr((string) preg_replace('/[^a-z0-9]/', '', explode('.', $domain)[0]), 0, 12);
        if (preg_match('/^[a-z]/', $base) !== 1 || strlen($base) < 3) {
            $base = 'site'.substr($base, 0, 8);
        }
        $name = $base;
        for ($i = 2; in_array($name, $taken, true) || $this->usernameTaken($name, $serverId); $i++) {
            $name = substr($base, 0, 16 - strlen((string) $i)).$i;
        }

        return $name;
    }

    private function usernameTaken(string $u, int $serverId): bool
    {
        return in_array($u, ProvisioningService::RESERVED, true)
            || HostingAccount::query()->withTrashed()->where('server_id', $serverId)->where('username', $u)->exists();
    }

    // ------------------------------------------------------------------ plan

    /** @param  list<array<string, mixed>>  $in  ImportPlanInput.items */
    public function plan(User $actor, PanelImport $imp, array $in): PanelImport
    {
        return DB::transaction(function () use ($actor, $imp, $in): PanelImport {
            /** @var PanelImport $imp */
            $imp = PanelImport::query()->lockForUpdate()->findOrFail($imp->id);
            if ($imp->state !== 'planned') {
                throw ApiProblem::conflict("Lượt import đang {$imp->state}: chỉ sửa kế hoạch khi đã quét xong (planned).");
            }
            /** @var Collection<string, ImportItem> $items */
            $items = ImportItem::query()->where('import_id', $imp->id)->get()->keyBy('uuid');
            $errors = [];
            $err = function (int $n, string $field, string $msg) use (&$errors): void {
                $errors["items.$n.$field"][] = $msg;
            };
            $index = [];
            foreach ($in as $n => $row) {
                $it = $items->get((string) $row['uuid']);
                if (! $it instanceof ImportItem) {
                    $err($n, 'uuid', 'Mục không thuộc lượt import này.');

                    continue;
                }
                $index[$it->uuid] = $n;
                $it->selected = (bool) $row['selected'];
                if (array_key_exists('username', $row) && $row['username'] !== null) {
                    $it->target_username = (string) $row['username'];
                }
                if (array_key_exists('package', $row) && $row['package'] !== null) {
                    $pkg = HostingPackage::query()->where('uuid', (string) $row['package'])->first();
                    if (! $pkg instanceof HostingPackage || ! $pkg->is_active) {
                        $err($n, 'package', 'Không có gói này hoặc gói đã ngừng bán.');
                    } else {
                        $it->target_package_id = $pkg->id;
                    }
                }
                if (array_key_exists('user', $row) && $row['user'] !== null) {
                    $u = User::query()->where('uuid', (string) $row['user'])->first();
                    if (! $u instanceof User || $u->realm !== 'portal' || $u->status !== 'active') {
                        $err($n, 'user', 'Chủ account phải là USER Portal đang hoạt động.');
                    } else {
                        $it->target_user_id = $u->id;
                        $it->target_new_user = null;
                    }
                } elseif (isset($row['new_user']) && is_array($row['new_user'])) {
                    $email = mb_strtolower(trim((string) $row['new_user']['email']));
                    if (User::query()->where('email', $email)->exists()) {
                        $err($n, 'new_user', "Email $email đã có người dùng: chọn USER có sẵn.");
                    } else {
                        $it->target_new_user = ['name' => trim((string) $row['new_user']['name']), 'email' => $email];
                        $it->target_user_id = null;
                    }
                }
            }
            // Kiểm toàn bộ mục đang chọn (kể cả mục không gửi lần này); lỗi gắn vào chỉ số của mục trong yêu cầu.
            $groups = [];
            foreach ($items as $it) {
                if (! $it->selected) {
                    continue;
                }
                $n = $index[$it->uuid] ?? null;
                if (collect($it->warnings)->contains(fn (array $w): bool => $w['code'] === 'domain_exists')
                    || WebsiteDomain::query()->whereIn('name', array_merge([$it->domain], $it->aliases))->exists()) {
                    if ($n !== null) {
                        $err($n, 'selected', "Domain {$it->domain} đã gắn với website ITSO.");
                    }

                    continue;
                }
                $u = (string) $it->target_username;
                if (preg_match('/^[a-z][a-z0-9]{2,15}$/', $u) !== 1 || in_array($u, ProvisioningService::RESERVED, true)) {
                    if ($n !== null) {
                        $err($n, 'username', 'Username 3–16 ký tự a-z0-9, bắt đầu bằng chữ, không trùng tên hệ thống.');
                    }

                    continue;
                }
                if ($this->usernameTaken($u, $imp->server_id)) {
                    if ($n !== null) {
                        $err($n, 'username', "Username $u đã có trên server: import luôn tạo account mới.");
                    }

                    continue;
                }
                $groups[$u][] = $it;
            }
            foreach ($groups as $u => $list) {
                $pkgIds = array_values(array_unique(array_filter(array_map(fn (ImportItem $i): ?int => $i->target_package_id, $list))));
                $owners = array_values(array_unique(array_filter(array_map(fn (ImportItem $i): ?string => $i->target_user_id !== null
                    ? 'u'.$i->target_user_id : ($i->target_new_user !== null ? 'e'.$i->target_new_user['email'] : null), $list))));
                foreach ($list as $i) {
                    $n = $index[$i->uuid] ?? null;
                    if ($n !== null && count($pkgIds) > 1) {
                        $err($n, 'package', "Các mục cùng username $u phải cùng một gói.");
                    }
                    if ($n !== null && count($owners) > 1) {
                        $err($n, 'user', "Các mục cùng username $u phải cùng một chủ.");
                    }
                }
                if (count($pkgIds) === 1) {
                    $over = $this->overQuota((int) $pkgIds[0], $list);
                    if ($over !== null) {
                        foreach ($list as $i) {
                            if (($n = $index[$i->uuid] ?? null) !== null) {
                                $err($n, 'package', $over);
                            }
                        }
                    }
                }
            }
            if ($errors !== []) {
                throw new ApiProblem(422, 'validation_failed', 'Kế hoạch import không hợp lệ', 'Sửa các mục được đánh dấu.', $errors);
            }
            foreach ($items as $it) {
                if ($it->isDirty()) {
                    $it->save();
                }
            }
            $imp->touch();
            $this->audit->record('import.plan', $imp, ['selected' => $items->where('selected', true)->count(), 'changed' => count($in)],
                'success', $imp->server_id, null, $actor);

            return $imp->refresh();
        });
    }

    /** @param  list<ImportItem>  $list  mục gộp vào một account mới */
    private function overQuota(int $packageId, array $list): ?string
    {
        $pkg = HostingPackage::query()->findOrFail($packageId);
        $v = $this->provisioning->currentVersion($pkg);
        $sites = count($list);
        $dbs = array_sum(array_map(fn (ImportItem $i): int => count($i->databases), $list));
        $mb = (int) ceil(array_sum(array_map(fn (ImportItem $i): int => $i->size_bytes + array_sum(array_column($i->databases, 'size_bytes')), $list)) / 1048576);
        $l = ['website_limit' => (int) $v->website_limit, 'database_limit' => (int) $v->database_limit, 'disk_mb' => (int) $v->disk_mb];

        return match (true) {
            $sites > $l['website_limit'] => "Gói {$pkg->name} cho tối đa {$l['website_limit']} website, kế hoạch có $sites.",
            $dbs > $l['database_limit'] => "Gói {$pkg->name} cho tối đa {$l['database_limit']} database, kế hoạch có $dbs.",
            $mb > $l['disk_mb'] => "Gói {$pkg->name} cho {$l['disk_mb']} MB, dữ liệu nguồn khoảng $mb MB.",
            default => null,
        };
    }

    // ------------------------------------------------------------------ run

    /** @return list<Job> mỗi account một job (job đầu trả về ở 202) */
    public function run(User $actor, PanelImport $imp, ?string $idempotencyKey = null): array
    {
        return DB::transaction(function () use ($actor, $imp, $idempotencyKey): array {
            /** @var PanelImport $imp */
            $imp = PanelImport::query()->lockForUpdate()->findOrFail($imp->id);
            if ($imp->state !== 'planned') {
                throw ApiProblem::conflict("Lượt import đang {$imp->state}: chỉ chạy lượt đã quét và lập kế hoạch.");
            }
            $server = Server::query()->findOrFail($imp->server_id);
            $this->ensureNotBusy($server);
            $items = ImportItem::query()->where('import_id', $imp->id)->orderBy('id')->get();
            $chosen = $items->where('selected', true)->values();
            if ($chosen->isEmpty()) {
                throw ApiProblem::conflict('Chưa chọn mục nào để import.');
            }
            $errors = [];
            foreach ($chosen as $n => $it) {
                if ($it->target_package_id === null) {
                    $errors["items.$n.package"][] = "Mục {$it->domain} chưa chọn gói.";
                }
                if ($it->target_user_id === null && $it->target_new_user === null) {
                    $errors["items.$n.user"][] = "Mục {$it->domain} chưa chọn chủ (USER có sẵn hoặc tạo mới).";
                }
                if (WebsiteDomain::query()->whereIn('name', array_merge([$it->domain], $it->aliases))->exists()) {
                    $errors["items.$n.selected"][] = "Domain {$it->domain} đã gắn với website ITSO.";
                }
            }
            if ($errors !== []) {
                throw new ApiProblem(422, 'validation_failed', 'Kế hoạch import chưa đủ', 'Hoàn tất kế hoạch rồi chạy lại.', $errors);
            }
            ImportItem::query()->where('import_id', $imp->id)->where('selected', false)->update(['state' => 'skipped', 'progress' => 0]);
            $imp->forceFill(['state' => 'running', 'error' => null])->save();
            $jobs = [];
            foreach ($chosen->groupBy('target_username') as $username => $list) {
                $jobs[] = $this->runAccount($actor, $imp, $server, (string) $username, $list->values(), $jobs === [] ? $idempotencyKey : null);
            }
            $imp->forceFill(['run_job_id' => $jobs[0]->id])->save();
            $this->audit->record('import.run', $imp, ['accounts' => count($jobs), 'sites' => $chosen->count()], 'success',
                $imp->server_id, $jobs[0]->id, $actor);

            return $jobs;
        });
    }

    /** @param  Collection<int, ImportItem>  $list */
    private function runAccount(User $actor, PanelImport $imp, Server $server, string $username, Collection $list, ?string $idem): Job
    {
        $first = $list->firstOrFail();
        $pkg = HostingPackage::query()->findOrFail($first->target_package_id);
        $owner = $first->target_user_id !== null ? User::query()->findOrFail($first->target_user_id) : $this->newOwner($actor, $first);
        $this->provisioning->assertCreatable($owner, $pkg, $server, $username);
        $a = $this->provisioning->newRecord($owner, $this->provisioning->currentVersion($pkg), $server, $username);
        $limits = $this->quota->limits($a);
        $spec = $this->provisioning->createSteps(new JobSpec('import.run', $imp, $server->id, 1, 12 * 3600), $a);
        $acct = DataSpec::acct($a);
        $ownerEnsured = false;
        foreach ($list as $it) {
            $w = Website::query()->create(['hosting_account_id' => $a->id, 'server_id' => $server->id, 'primary_domain' => $it->domain,
                'type' => $it->php_version !== null ? 'php' : 'static', 'document_root' => self::DOC_ROOT,
                'php_version' => $it->php_version !== null ? $this->importPhp($a, (string) $it->php_version) : null,
                'ssl_mode' => 'none', 'status' => 'provisioning', 'spec_version' => 1]);
            WebsiteDomain::query()->create(['website_id' => $w->id, 'name' => $it->domain, 'type' => 'primary']);
            foreach ($it->aliases as $alias) {
                WebsiteDomain::query()->create(['website_id' => $w->id, 'name' => $alias, 'type' => 'alias']);
            }
            $php = WebsiteSpec::PHP_DEFAULTS;
            $php['pm_max_children'] = max(1, min(64, (int) $php['pm_max_children'], (int) ($limits['php_workers_max'] ?? 5)));
            WebsiteSetting::query()->create(['website_id' => $w->id, 'nginx' => WebsiteSpec::NGINX_DEFAULTS, 'php' => $php]);
            $w->load('settings');
            $spec->step('fs.site_layout.ensure', WebsiteSpec::layout($w, $a))
                ->step('import.copy', ['source' => $imp->source, 'src' => $it->docroot, 'account' => $acct,
                    'dst' => 'sites/'.$it->domain.'/'.self::DOC_ROOT, 'max_bytes' => max(1, (int) $limits['disk_mb']) * 1048576]);
            if ($w->type === 'php') {
                $spec->step('php.pool.apply', WebsiteSpec::pool($w, $a));
            }
            $spec->step('nginx.vhost.apply', WebsiteSpec::vhost($w, $a, false, false));
            $dbMap = [];
            foreach ($it->databases as $src) {
                if (! $ownerEnsured) {
                    $spec->step('db.mysql.owner_ensure', ['account' => $acct]);
                    $ownerEnsured = true;
                }
                $name = $this->targetDbName($a, (string) $src['name']);
                $db = Database::query()->create(['hosting_account_id' => $a->id, 'server_id' => $server->id, 'engine' => 'mariadb',
                    'name' => $name, 'charset' => 'utf8mb4', 'status' => 'provisioning', 'size_mb' => intdiv((int) $src['size_bytes'], 1048576)]);
                $user = DatabaseUser::query()->create(['hosting_account_id' => $a->id, 'server_id' => $server->id, 'engine' => 'mariadb',
                    'username' => $name, 'password_encrypted' => Crypt::encryptString(DataSpec::password()), 'host_pattern' => 'localhost',
                    'max_connections' => 10, 'status' => 'provisioning']);
                DB::table('database_grants')->insert(['database_id' => $db->id, 'database_user_id' => $user->id,
                    'privileges' => DataSpec::toPgArray(['ALL'])]);
                $dump = '.itso-import/'.$imp->uuid.'-'.$name.'.sql';
                $spec->step('db.mysql.create', ['account' => $acct, 'name' => $name, 'charset' => 'utf8mb4'])
                    ->step('db.mysql.user_ensure', ['account' => $acct, 'username' => $name,
                        'password' => Secrets::ref('db_user_password', $user->uuid), 'host' => 'localhost', 'max_connections' => 10])
                    ->step('db.mysql.grant', ['account' => $acct, 'username' => $name, 'database' => $name, 'privileges' => ['ALL']])
                    ->step('import.db_dump', ['source' => $imp->source, 'source_db' => (string) $src['name'], 'account' => $acct,
                        'target' => $dump, 'max_bytes' => max(1, (int) $limits['disk_mb']) * 1048576])
                    ->step('db.mysql.import', ['account' => $acct, 'name' => $name, 'source' => $dump])
                    ->step('fs.delete', ['account' => $acct, 'paths' => [$dump]]);
                $dbMap[(string) $src['name']] = $name;
            }
            foreach ($it->crons as $c) {
                CronJob::query()->create(['hosting_account_id' => $a->id, 'website_id' => $w->id, 'schedule' => $c['schedule'],
                    'command' => mb_substr($c['command'], 0, 1000), 'working_dir' => '.', 'enabled' => false, 'status' => 'pending',
                    'observed_facts' => ['imported_from' => $imp->source, 'note' => 'Tắt sau import: sửa đường dẫn cũ rồi bật.']]);
            }
            $it->forceFill(['hosting_account_id' => $a->id, 'state' => 'running', 'progress' => 0,
                'result' => ['website_uuid' => $w->uuid, 'databases' => $dbMap]])->save();
        }
        $job = $this->jobs->dispatch($spec, $actor, $idem);
        HostingAccount::query()->whereKey($a->id)->update(['last_job_id' => $job->id]);
        Website::query()->where('hosting_account_id', $a->id)->update(['last_job_id' => $job->id]);
        $this->provisioning->event($a, null, 'provisioning', 'Import từ '.$imp->source, $actor, $job);
        $this->audit->record('hosting_account.create', $a, ['username' => $username, 'server' => $server->name, 'import' => $imp->uuid,
            'sites' => $list->pluck('domain')->all()], 'success', $server->id, $job->id, $actor);

        return $job;
    }

    private function newOwner(User $actor, ImportItem $it): User
    {
        $nu = $it->target_new_user;
        if ($nu === null) {
            throw ApiProblem::conflict("Mục {$it->domain} chưa chọn chủ account.");
        }
        $existing = User::query()->where('email', $nu['email'])->first();
        if ($existing instanceof User) {
            return $existing;
        }
        $u = User::query()->create(['realm' => 'portal', 'name' => $nu['name'], 'email' => $nu['email'],
            'password_hash' => UserService::unusablePassword(), 'locale' => 'vi', 'status' => 'active', 'created_by_user_id' => $actor->id]);
        $this->users->setRole($u, 'USER');
        $this->audit->record('user.create', $u, ['realm' => 'portal', 'email' => $u->email, 'role' => 'USER', 'via' => 'import'], 'success', null, null, $actor);

        return $u;
    }

    /** Tên DB mới: <username>_<phần sau tiền tố của tên nguồn>, a-z0-9_, ≤ 64, không trùng trên server. */
    private function targetDbName(HostingAccount $a, string $src): string
    {
        $tail = str_contains($src, '_') ? substr($src, strpos($src, '_') + 1) : $src;
        $tail = substr((string) preg_replace('/[^a-z0-9_]/', '', strtolower($tail)), 0, 64 - strlen($a->username) - 4) ?: 'db';
        $name = $a->username.'_'.$tail;
        for ($i = 2; Database::query()->where('server_id', $a->server_id)->where('name', $name)->exists()
            || DatabaseUser::query()->where('server_id', $a->server_id)->where('username', $name)->exists(); $i++) {
            $name = $a->username.'_'.$tail.$i;
        }

        return $name;
    }

    /** Một job import.run kết thúc: cập nhật mục, account, site, DB; hết job đang chạy → completed / partially_failed. */
    public function runFinished(PanelImport $imp, Job $job, bool $ok): void
    {
        $steps = JobStep::query()->where('job_id', $job->id)->orderBy('seq')->get();
        $accountId = HostingAccount::query()->where('last_job_id', $job->id)->value('id');
        $items = ImportItem::query()->where('import_id', $imp->id)->where('hosting_account_id', $accountId)->get();
        $acct = $accountId !== null ? HostingAccount::query()->find($accountId) : null;
        $err = $ok ? null : mb_substr(trim(($job->error_code ? "[{$job->error_code}] " : '').(string) $job->error_message), 0, 500);
        foreach ($items as $it) {
            $copy = $steps->first(fn (JobStep $s): bool => $s->op === 'import.copy' && ($s->params_redacted['src'] ?? '') === $it->docroot);
            $dbMap = (array) ($it->result['databases'] ?? []);
            $tables = 0;
            $dbOk = true;
            foreach ($dbMap as $srcDb => $dst) {
                $d = $steps->first(fn (JobStep $s): bool => $s->op === 'import.db_dump' && ($s->params_redacted['source_db'] ?? '') === $srcDb);
                $im = $steps->first(fn (JobStep $s): bool => $s->op === 'db.mysql.import' && ($s->params_redacted['name'] ?? '') === $dst);
                $tables += (int) ($d?->result['tables'] ?? 0);
                $dbOk = $dbOk && $d?->state === 'succeeded' && $im?->state === 'succeeded';
            }
            $copied = $copy?->state === 'succeeded';
            $done = $ok || ($copied && $dbOk && $this->siteStepsOk($steps, $it->domain));
            $it->forceFill(['state' => $done ? 'done' : 'failed', 'progress' => $done ? 100 : (int) $job->progress,
                'result' => ['website_uuid' => $it->result['website_uuid'] ?? null, 'databases' => $dbMap,
                    'hosting_account_id' => $accountId,
                    'files' => (int) ($copy?->result['files'] ?? 0), 'bytes' => (int) ($copy?->result['bytes'] ?? 0),
                    'skipped' => (int) ($copy?->result['skipped'] ?? 0),
                    'skipped_reasons' => array_values(array_map('strval', (array) ($copy?->result['skipped_reasons'] ?? []))),
                    'db_tables' => $tables, 'db_rows_match' => $dbMap === [] || $dbOk,
                    'certificate' => ($it->ssl['state'] ?? 'none') === 'none' ? 'none' : null, 'error' => $done ? null : $err]])->save();
            $wid = Website::query()->where('uuid', (string) ($it->result['website_uuid'] ?? ''))->value('id');
            if ($wid !== null) {
                Website::query()->whereKey($wid)->update(['status' => $done ? 'ready' : 'failed', 'observed_version' => $done ? 1 : 0,
                    'observed_at' => Carbon::now(), 'drift' => $done ? null : json_encode(['apply' => $err])]);
            }
        }
        if ($acct instanceof HostingAccount) {
            $from = $acct->lifecycle_state;
            $acct->lifecycle_state = $ok ? 'active' : 'failed';
            $acct->status = $ok ? 'ready' : 'failed';
            $acct->observed_version = $ok ? $acct->spec_version : $acct->observed_version;
            $acct->observed_at = Carbon::now();
            $acct->save();
            $this->provisioning->event($acct, $from, $acct->lifecycle_state, $ok ? 'Import xong' : $err, null, $job);
            $dbIds = Database::query()->where('hosting_account_id', $acct->id)->pluck('id');
            Database::query()->whereIn('id', $dbIds)->update(['status' => $ok ? 'ready' : 'failed']);
            DatabaseUser::query()->where('hosting_account_id', $acct->id)->update(['status' => $ok ? 'ready' : 'failed']);
        }
        $this->settle($imp);
    }

    /** @param  Collection<int, JobStep>  $steps */
    private function siteStepsOk(Collection $steps, string $domain): bool
    {
        return $steps->filter(fn (JobStep $s): bool => in_array($s->op, ['fs.site_layout.ensure', 'nginx.vhost.apply', 'php.pool.apply'], true)
            && ($s->params_redacted['site_dir'] ?? '') === $domain)->every(fn (JobStep $s): bool => $s->state === 'succeeded');
    }

    /** Khi không còn job import.run nào đang chạy: completed nếu mọi mục xong, ngược lại partially_failed. */
    public function settle(PanelImport $imp): void
    {
        $running = Job::query()->where('type', 'import.run')->where('resource_type', 'import')->where('resource_id', $imp->id)
            ->whereIn('state', self::ACTIVE_JOB)->exists();
        if ($running) {
            return;
        }
        $states = ImportItem::query()->where('import_id', $imp->id)->where('selected', true)->pluck('state')->all();
        $failed = count(array_filter($states, fn (string $s): bool => $s === 'failed'));
        $state = $failed === 0 ? 'completed' : 'partially_failed';
        $imp->forceFill(['state' => $state, 'error' => $failed > 0 ? "$failed mục lỗi: xem từng mục, có thể cutover các mục đã xong." : null])->save();
    }

    // ------------------------------------------------------------------ cutover / rollback

    public function cutover(User $actor, PanelImport $imp, ?string $idempotencyKey = null): Job
    {
        return DB::transaction(function () use ($actor, $imp, $idempotencyKey): Job {
            /** @var PanelImport $imp */
            $imp = PanelImport::query()->lockForUpdate()->findOrFail($imp->id);
            if (! in_array($imp->state, ['completed', 'partially_failed'], true)) {
                throw ApiProblem::conflict("Lượt import đang {$imp->state}: chỉ cutover sau khi chạy import xong.");
            }
            $this->ensureNoJob($imp);
            $done = ImportItem::query()->where('import_id', $imp->id)->where('state', 'done')->orderBy('id')->get();
            if ($done->isEmpty()) {
                throw ApiProblem::conflict('Không có mục nào import xong để cutover.');
            }
            $spec = (new JobSpec('import.cutover', $imp, $imp->server_id, 1, 1800))
                ->step('import.cutover', ['source' => $imp->source, 'import_uuid' => $imp->uuid,
                    'vhost_paths' => $done->pluck('vhost_path')->unique()->values()->all()]);
            // Sau khi tắt vhost nguồn, domain về vhost ITSO: xin chứng chỉ cho site có SSL ở nguồn (nếu đã cấu hình ACME).
            $acme = $this->acmeReady();
            $certs = [];
            foreach ($done as $it) {
                if (($it->ssl['state'] ?? 'none') === 'none' || ! $acme) {
                    continue;
                }
                $w = Website::query()->where('uuid', (string) ($it->result['website_uuid'] ?? ''))->first();
                $a = $w instanceof Website ? HostingAccount::query()->find($w->hosting_account_id) : null;
                if ($w instanceof Website && $a instanceof HostingAccount) {
                    $certs[] = CertificateService::appendAcme($spec, $w, $a, 'none')->id;
                }
            }
            $job = $this->jobs->dispatch($spec, $actor, $idempotencyKey);
            Certificate::query()->whereIn('id', $certs)->whereNull('last_job_id')->update(['last_job_id' => $job->id]);
            $this->audit->record('import.cutover', $imp, ['vhosts' => $done->count()], 'success', $imp->server_id, $job->id, $actor);

            return $job;
        });
    }

    public function rollback(User $actor, PanelImport $imp, ?string $idempotencyKey = null): Job
    {
        return DB::transaction(function () use ($actor, $imp, $idempotencyKey): Job {
            /** @var PanelImport $imp */
            $imp = PanelImport::query()->lockForUpdate()->findOrFail($imp->id);
            if ($imp->state !== 'cut_over') {
                throw ApiProblem::conflict("Lượt import đang {$imp->state}: chỉ quay lại sau cutover.");
            }
            $this->ensureNoJob($imp);
            $paths = ImportItem::query()->where('import_id', $imp->id)->where('state', 'done')->pluck('vhost_path')->unique()->values()->all();
            $spec = (new JobSpec('import.rollback', $imp, $imp->server_id, 1, 600))
                ->step('import.rollback', ['source' => $imp->source, 'import_uuid' => $imp->uuid, 'vhost_paths' => $paths]);
            $job = $this->jobs->dispatch($spec, $actor, $idempotencyKey);
            $this->audit->record('import.rollback', $imp, ['vhosts' => count($paths)], 'success', $imp->server_id, $job->id, $actor);

            return $job;
        });
    }

    /**
     * Cutover xong (kể cả khi chỉ bước chứng chỉ lỗi: vhost nguồn đã tắt). Mỗi chứng chỉ ACME của job được chốt theo
     * bước cert.issue của nó (job dừng ở bước lỗi đầu tiên: chứng chỉ phía sau chưa chạy → failed, xin lại ở trang SSL).
     */
    public function cutoverFinished(PanelImport $imp, Job $job, bool $ok): void
    {
        $steps = JobStep::query()->where('job_id', $job->id)->orderBy('seq')->get();
        $cut = $steps->firstWhere('op', 'import.cutover')?->state === 'succeeded';
        $issued = [];
        foreach (Certificate::query()->where('last_job_id', $job->id)->lockForUpdate()->get() as $c) {
            $st = $steps->first(fn (JobStep $s): bool => $s->op === 'cert.issue' && ($s->params_redacted['cert_uuid'] ?? '') === $c->uuid);
            $vh = $st !== null ? $steps->first(fn (JobStep $s): bool => $s->op === 'nginx.vhost.apply' && $s->seq > $st->seq) : null;
            $res = $st?->state === 'succeeded' && is_array($st->result) ? $st->result : null;
            if ($res !== null) {
                $c->fill(['status' => 'ready', 'issuer' => mb_substr((string) ($res['issuer'] ?? ''), 0, 500),
                    'not_before' => isset($res['not_before']) ? Carbon::parse((string) $res['not_before']) : null,
                    'not_after' => isset($res['not_after']) ? Carbon::parse((string) $res['not_after']) : null,
                    'observed_version' => $c->spec_version, 'observed_at' => Carbon::now(), 'last_error' => null])->save();
            } else {
                $c->fill(['status' => 'failed', 'last_error' => mb_substr((string) ($job->error_message ?? $job->state), 0, 500)])->save();
            }
            $live = $res !== null && $vh?->state === 'succeeded';
            Website::query()->whereKey($c->website_id)->update(['ssl_mode' => $live ? 'acme' : 'none']);
            if ($live) {
                $issued[] = $c->website_id;
            }
        }
        if (! $cut) {
            $imp->forceFill(['error' => 'Cutover lỗi (đã hoàn tác vhost nguồn): '.mb_substr((string) $job->error_message, 0, 300)])->save();

            return;
        }
        $imp->forceFill(['state' => 'cut_over', 'cutover_at' => Carbon::now(),
            'error' => $ok ? null : 'Đã tắt vhost nguồn; cấp chứng chỉ lỗi: '.mb_substr((string) $job->error_message, 0, 300)])->save();
        foreach (ImportItem::query()->where('import_id', $imp->id)->where('state', 'done')->get() as $it) {
            if (($it->ssl['state'] ?? 'none') === 'none') {
                continue;
            }
            $wid = Website::query()->where('uuid', (string) ($it->result['website_uuid'] ?? ''))->value('id');
            $r = (array) $it->result;
            $r['certificate'] = in_array($wid, $issued, true) ? 'acme' : 'none';
            $it->forceFill(['result' => $r])->save();
        }
    }

    public function rollbackFinished(PanelImport $imp, Job $job, bool $ok): void
    {
        $imp->forceFill($ok ? ['state' => 'rolled_back', 'error' => null]
            : ['error' => 'Quay lại lỗi: '.mb_substr((string) $job->error_message, 0, 300)])->save();
    }

    public function delete(User $actor, PanelImport $imp): void
    {
        DB::transaction(function () use ($actor, $imp): void {
            /** @var PanelImport $imp */
            $imp = PanelImport::query()->lockForUpdate()->findOrFail($imp->id);
            if (in_array($imp->state, PanelImport::BUSY, true)) {
                throw ApiProblem::conflict('Lượt import đang chạy, chờ xong rồi xóa.');
            }
            ImportItem::query()->where('import_id', $imp->id)->delete();
            $this->audit->record('import.delete', $imp, ['source' => $imp->source, 'state' => $imp->state], 'success', $imp->server_id, null, $actor);
            $imp->delete();
        });
    }

    private function ensureNoJob(PanelImport $imp): void
    {
        if (Job::query()->where('resource_type', 'import')->where('resource_id', $imp->id)->whereIn('state', self::ACTIVE_JOB)->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'Lượt import đang có tác vụ chạy', 'Chờ tác vụ hiện tại xong rồi thử lại.');
        }
    }

    private function acmeReady(): bool
    {
        try {
            WebsiteSpec::acmeEmail();
            WebsiteSpec::acmeDirectory();

            return true;
        } catch (ApiProblem) {
            return false;
        }
    }

    /** PHP đích: giữ phiên bản nguồn nếu hỗ trợ, gói cho phép và đã cài trên server; không thì PHP mặc định (D-108). */
    private function importPhp(HostingAccount $a, string $src): string
    {
        $allowed = $a->packageVersion->php_versions ?? [];
        $ok = fn (string $v): bool => PhpCatalog::supported($v) && ($allowed === [] || in_array($v, $allowed, true))
            && PhpVersion::query()->where('server_id', $a->server_id)->where('version', $v)->where('status', 'ready')->exists();
        if ($ok($src)) {
            return $src;
        }
        foreach (array_merge([PhpCatalog::DEFAULT], array_reverse(PhpCatalog::SUPPORTED)) as $v) {
            if ($ok($v)) {
                return $v;
            }
        }

        return PhpCatalog::DEFAULT;
    }
}
