<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Models\SoftwareCatalog;
use Illuminate\Database\Seeder;

/**
 * Danh mục phần mềm = các recipe agent hỗ trợ (contracts/agent-ops/defs.schema.json `Recipe`).
 * `versions[0]`: bản trong kho Ubuntu 24.04 (noble) tại thời điểm viết; bản thật đọc từ dpkg sau khi cài.
 */
class SoftwareCatalogSeeder extends Seeder
{
    /** @var list<array{0: string, 1: string, 2: string, 3: string}> key, tên, nhóm, bản noble */
    public const RECIPES = [
        ['acl', 'ACL (setfacl/getfacl)', 'base', '2.3.2'],
        ['quota', 'Disk quota (quota tools)', 'base', '4.06'],
        ['nftables', 'nftables', 'security', '1.0.9'],
        ['restic', 'Restic (sao lưu)', 'base', '0.16.4'],
        ['stress-ng', 'stress-ng (kiểm tải VM test)', 'tools', '0.17.06'],
        // Phase 5 (web stack). PHP 8.3 quản lý ở PHP Manager (php.version.install), không qua recipe.
        ['nginx', 'Nginx', 'web', '1.24.0'],
        ['lego', 'lego (ACME client)', 'web', '4.9.1'],
    ];

    public function run(): void
    {
        foreach (self::RECIPES as [$key, $name, $category, $version]) {
            SoftwareCatalog::query()->updateOrCreate(['key' => $key],
                ['name' => $name, 'category' => $category, 'versions' => [$version], 'conflicts' => []]);
        }
    }
}
