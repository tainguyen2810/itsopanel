<?php

declare(strict_types=1);

namespace Database\Factories;

use App\Models\HostingPackageVersion;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<HostingPackageVersion> */
class HostingPackageVersionFactory extends Factory
{
    public function definition(): array
    {
        return [
            'version' => 1,
            'disk_mb' => 10240,
            'inode_limit' => 200000,
            'cpu_percent' => 100,
            'ram_mb' => 2048,
            'tasks_max' => 200,
            'php_workers_max' => 4,
            'io_weight' => 100,
            'website_limit' => 5,
            'alias_domain_limit' => 10,
            'subdomain_limit' => 10,
            'database_limit' => 5,
            'db_user_limit' => 5,
            'ftp_limit' => 5,
            'cron_limit' => 5,
            'cron_min_interval_min' => 5,
            'backup_quota_mb' => 20480,
            'backup_retention' => ['daily' => 7, 'weekly' => 4, 'monthly' => 3],
            'ssh_allowed' => false,
            'php_versions' => ['8.2', '8.3'],
            'retention_days_after_terminate' => 30,
        ];
    }
}
