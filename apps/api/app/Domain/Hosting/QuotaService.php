<?php

declare(strict_types=1);

namespace App\Domain\Hosting;

use App\Exceptions\ApiProblem;
use App\Models\HostingAccount;
use App\Models\HostingPackageVersion;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Quota phía panel (D-49): giới hạn hiệu lực = phiên bản gói + limits_override; mức dùng = đếm phía panel
 * (website, database, FTP, cron — bảng có từ Phase 5–6) + số đo gần nhất từ agent (account_usage_snapshots).
 * Vượt giới hạn → 422 `quota_exceeded`. Phase 5–6 gọi `ensureCanAdd()` trước khi tạo tài nguyên.
 */
final class QuotaService
{
    /** Tài nguyên đếm được → khóa giới hạn. */
    public const COUNTED = ['websites' => 'website_limit', 'databases' => 'database_limit', 'ftp_accounts' => 'ftp_limit',
        'cron_jobs' => 'cron_limit'];

    /** Tài nguyên → bảng đếm (chỉ đếm khi bảng đã có trong schema của Phase hiện tại). */
    private const TABLES = ['websites' => 'websites', 'databases' => 'databases', 'ftp_accounts' => 'sftp_accounts',
        'cron_jobs' => 'cron_jobs'];

    /** @var array<string, bool> */
    private array $tableExists = [];

    /** @var array<string, bool> */
    private array $hasDeletedAt = [];

    /**
     * Dữ liệu nạp trước cho một trang danh sách (Prompt 12.5, chặn N+1): chỉ `usage()` đọc, `count()` luôn đếm thật.
     *
     * @var array{counts: array<string, array<int, int>>, snaps: array<int, array<string, mixed>|null>}|null
     */
    private ?array $batch = null;

    /**
     * Nạp trước số đếm + số đo gần nhất cho nhiều account (một truy vấn mỗi bảng) để `usage()` không truy vấn theo dòng.
     *
     * @param  list<int>  $ids
     */
    public function prefetchUsage(array $ids): void
    {
        $this->batch = ['counts' => [], 'snaps' => array_fill_keys($ids, null)];
        if ($ids === []) {
            return;
        }
        foreach (self::TABLES as $resource => $table) {
            $this->batch['counts'][$resource] = array_map('intval', $this->countQuery($resource, $table)
                ->whereIn('hosting_account_id', $ids)->groupBy('hosting_account_id')
                ->selectRaw('hosting_account_id, count(*) as n')->pluck('n', 'hosting_account_id')->all());
        }
        $snaps = DB::table('account_usage_snapshots')->whereIn('hosting_account_id', $ids)
            ->selectRaw('DISTINCT ON (hosting_account_id) *')->orderBy('hosting_account_id')->orderByDesc('at')->get();
        if ($snaps->isEmpty()) {
            return;
        }
        $since = Carbon::parse((string) $snaps->min('at'))->subMinutes(1);
        $cpu = DB::table('metric_samples')->whereIn('hosting_account_id', $snaps->pluck('hosting_account_id')->all())
            ->where('metric', 'cpu_pct')->where('at', '>=', $since)
            ->selectRaw('DISTINCT ON (hosting_account_id) hosting_account_id, value, at')
            ->orderBy('hosting_account_id')->orderByDesc('at')->get()->keyBy('hosting_account_id');
        foreach ($snaps as $r) {
            $c = $cpu->get($r->hosting_account_id);
            $ok = $c !== null && Carbon::parse((string) $c->at)->gte(Carbon::parse((string) $r->at)->subMinutes(1));
            $this->batch['snaps'][(int) $r->hosting_account_id] = self::snapRow($r, $ok ? $c->value : null);
        }
    }

    /** @return array<string, mixed> giới hạn hiệu lực */
    public function limits(HostingAccount $a, ?HostingPackageVersion $version = null): array
    {
        $version ??= HostingPackageVersion::query()->findOrFail($a->package_version_id);
        $l = PackageLimits::of($version);
        foreach ($a->limits_override as $k => $v) {
            if (in_array($k, PackageLimits::INT_KEYS, true) && is_int($v)) {
                $l[$k] = $v;
            }
        }

        return $l;
    }

    /** Số tài nguyên đang có (đếm phía panel). */
    public function count(HostingAccount $a, string $resource): int
    {
        $table = self::TABLES[$resource] ?? null;
        if ($table === null) {
            return 0;
        }
        $this->tableExists[$table] ??= DB::getSchemaBuilder()->hasTable($table);
        if (! $this->tableExists[$table]) {
            return 0;
        }

        return $this->countQuery($resource, $table)->where('hosting_account_id', $a->id)->count();
    }

    private function countQuery(string $resource, string $table): Builder
    {
        $q = DB::table($table);
        if ($this->hasDeletedAt[$table] ??= DB::getSchemaBuilder()->hasColumn($table, 'deleted_at')) {
            $q->whereNull('deleted_at');
        }
        if ($resource === 'ftp_accounts') {
            $q->where('protocol', 'ftps'); // ftp_limit chỉ đếm FTPS phụ, không tính user SFTP chính (ADR 0020 §5)
        }

        return $q;
    }

    private function usedCount(HostingAccount $a, string $resource): int
    {
        return $this->batch !== null && array_key_exists($a->id, $this->batch['snaps'])
            ? (int) ($this->batch['counts'][$resource][$a->id] ?? 0) : $this->count($a, $resource);
    }

    /** 422 quota_exceeded nếu thêm `$adding` tài nguyên vượt giới hạn. */
    public function ensureCanAdd(HostingAccount $a, string $resource, int $adding = 1): void
    {
        $key = self::COUNTED[$resource] ?? throw new \InvalidArgumentException("Không có quota cho $resource");
        $limit = (int) $this->limits($a)[$key];
        $used = $this->count($a, $resource);
        if ($used + $adding > $limit) {
            throw self::exceeded($resource, "Đã dùng $used/$limit $resource theo gói.");
        }
    }

    /**
     * Giới hạn mới có chứa được mức đang dùng không (đổi gói, giảm override, chuyển phiên bản). Vượt → 422.
     *
     * @param  array<string, mixed>  $newLimits
     */
    public function ensureFits(HostingAccount $a, array $newLimits): void
    {
        foreach (self::COUNTED as $res => $key) {
            $used = $this->count($a, $res);
            if ($used > (int) $newLimits[$key]) {
                throw self::exceeded($res, "Đang có $used $res, giới hạn mới chỉ cho {$newLimits[$key]}.");
            }
        }
        $snap = $this->snapshot($a);
        if ($snap !== null && $snap['disk_mb'] > (int) $newLimits['disk_mb']) {
            throw self::exceeded('disk_mb', "Đang dùng {$snap['disk_mb']} MB, giới hạn mới {$newLimits['disk_mb']} MB.");
        }
        if ($snap !== null && $snap['inode_count'] > (int) $newLimits['inode_limit']) {
            throw self::exceeded('inodes', "Đang dùng {$snap['inode_count']} inode, giới hạn mới {$newLimits['inode_limit']}.");
        }
    }

    /** @return array<string, mixed> Usage theo contract */
    public function usage(HostingAccount $a, ?HostingPackageVersion $version = null): array
    {
        $l = $this->limits($a, $version);
        $snap = $this->batch !== null && array_key_exists($a->id, $this->batch['snaps']) ? $this->batch['snaps'][$a->id] : $this->snapshot($a);
        $item = fn (float|int $used, int $limit): array => ['used' => $used, 'limit' => $limit];

        return [
            'disk_mb' => $item($snap['disk_mb'] ?? 0, $l['disk_mb']),
            'inodes' => $item($snap['inode_count'] ?? 0, $l['inode_limit']),
            'cpu_percent' => $item($snap['cpu_pct'] ?? 0, $l['cpu_percent']),
            'ram_mb' => $item($snap['mem_peak_mb'] ?? 0, $l['ram_mb']),
            'websites' => $item($this->usedCount($a, 'websites'), $l['website_limit']),
            'databases' => $item($this->usedCount($a, 'databases'), $l['database_limit']),
            'ftp_accounts' => $item($this->usedCount($a, 'ftp_accounts'), $l['ftp_limit']),
            'cron_jobs' => $item($this->usedCount($a, 'cron_jobs'), $l['cron_limit']),
            'backup_mb' => $item($snap['backup_size_mb'] ?? 0, $l['backup_quota_mb']),
            'bandwidth_mb_30d' => 0,
            'measured_at' => ($snap !== null ? Carbon::parse($snap['at']) : $a->updated_at)->toIso8601String(),
        ];
    }

    /**
     * Số đo gần nhất từ account_usage_snapshots và mẫu CPU gần nhất (metric_samples), cả hai ghi bởi
     * `php artisan itso:usage-refresh` từ op quota.report.
     *
     * @return array{disk_mb: int, inode_count: int, mem_peak_mb: int, backup_size_mb: int, cpu_pct: float, at: string}|null */
    private function snapshot(HostingAccount $a): ?array
    {
        $r = DB::table('account_usage_snapshots')->where('hosting_account_id', $a->id)->orderByDesc('at')->first();
        if ($r === null) {
            return null;
        }

        return self::snapRow($r, $this->cpuAt($a->id, (string) $r->at));
    }

    private function cpuAt(int $accountId, string $at): mixed
    {
        return DB::table('metric_samples')->where('hosting_account_id', $accountId)->where('metric', 'cpu_pct')
            ->where('at', '>=', Carbon::parse($at)->subMinutes(1))->orderByDesc('at')->value('value');
    }

    /** @return array{disk_mb: int, inode_count: int, mem_peak_mb: int, backup_size_mb: int, cpu_pct: float, at: string} */
    private static function snapRow(\stdClass $r, mixed $cpu): array
    {
        return ['disk_mb' => (int) ($r->disk_mb ?? 0), 'inode_count' => (int) ($r->inode_count ?? 0),
            'mem_peak_mb' => (int) ($r->mem_peak_mb ?? 0), 'backup_size_mb' => (int) ($r->backup_size_mb ?? 0),
            'cpu_pct' => is_numeric($cpu) ? (float) $cpu : 0.0, 'at' => Carbon::parse($r->at)->toIso8601String()];
    }

    public static function exceeded(string $resource, string $detail): ApiProblem
    {
        return new ApiProblem(422, 'quota_exceeded', 'Vượt giới hạn gói', $detail, [$resource => [$detail]]);
    }
}
