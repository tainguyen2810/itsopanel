<?php

declare(strict_types=1);

namespace App\Domain\Hosting;

use App\Exceptions\ApiProblem;
use App\Models\HostingAccount;
use App\Models\HostingPackageVersion;
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
        $q = DB::table($table)->where('hosting_account_id', $a->id);
        if (DB::getSchemaBuilder()->hasColumn($table, 'deleted_at')) {
            $q->whereNull('deleted_at');
        }
        if ($resource === 'ftp_accounts') {
            $q->where('protocol', 'ftps'); // ftp_limit chỉ đếm FTPS phụ, không tính user SFTP chính (ADR 0020 §5)
        }

        return $q->count();
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
        $snap = $this->snapshot($a);
        $item = fn (float|int $used, int $limit): array => ['used' => $used, 'limit' => $limit];

        return [
            'disk_mb' => $item($snap['disk_mb'] ?? 0, $l['disk_mb']),
            'inodes' => $item($snap['inode_count'] ?? 0, $l['inode_limit']),
            'cpu_percent' => $item($snap['cpu_pct'] ?? 0, $l['cpu_percent']),
            'ram_mb' => $item($snap['mem_peak_mb'] ?? 0, $l['ram_mb']),
            'websites' => $item($this->count($a, 'websites'), $l['website_limit']),
            'databases' => $item($this->count($a, 'databases'), $l['database_limit']),
            'ftp_accounts' => $item($this->count($a, 'ftp_accounts'), $l['ftp_limit']),
            'cron_jobs' => $item($this->count($a, 'cron_jobs'), $l['cron_limit']),
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
        $cpu = DB::table('metric_samples')->where('hosting_account_id', $a->id)->where('metric', 'cpu_pct')
            ->where('at', '>=', Carbon::parse($r->at)->subMinutes(1))->orderByDesc('at')->value('value');

        return ['disk_mb' => (int) ($r->disk_mb ?? 0), 'inode_count' => (int) ($r->inode_count ?? 0),
            'mem_peak_mb' => (int) ($r->mem_peak_mb ?? 0), 'backup_size_mb' => (int) ($r->backup_size_mb ?? 0),
            'cpu_pct' => is_numeric($cpu) ? (float) $cpu : 0.0, 'at' => Carbon::parse($r->at)->toIso8601String()];
    }

    public static function exceeded(string $resource, string $detail): ApiProblem
    {
        return new ApiProblem(422, 'quota_exceeded', 'Vượt giới hạn gói', $detail, [$resource => [$detail]]);
    }
}
