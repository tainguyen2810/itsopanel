<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Models\SoftwareCatalog;
use Illuminate\Database\Seeder;

/**
 * Danh mục phần mềm = các recipe agent hỗ trợ (contracts/agent-ops/defs.schema.json `Recipe`).
 * Nguồn sự thật là op `software.catalog` của agent (D-100): `itso:software-refresh` đồng bộ lại; bản seed này khớp
 * catalog trong agent/internal/ops/software.go để panel dùng được khi agent chưa trả lời.
 * `versions[0]`: bản trong kho tại thời điểm viết; bản thật đọc từ dpkg/apt-cache qua `software.status`.
 */
class SoftwareCatalogSeeder extends Seeder
{
    /**
     * key => [tên, nhóm, bản tham khảo, kho, dịch vụ, lõi, xung đột, phụ thuộc, gói]
     *
     * @var array<string, array{0: string, 1: string, 2: string, 3: string, 4: string|null, 5: bool, 6: list<string>, 7: list<string>, 8: list<string>}>
     */
    public const RECIPES = [
        'acl' => ['ACL (setfacl/getfacl)', 'base', '2.3.2', 'ubuntu', null, true, [], [], ['acl']],
        'quota' => ['Disk quota', 'base', '4.06', 'ubuntu', null, true, [], [], ['quota']],
        'nftables' => ['nftables', 'security', '1.0.9', 'ubuntu', null, true, [], [], ['nftables']],
        'restic' => ['restic', 'base', '0.16.4', 'ubuntu', null, true, [], [], ['restic']],
        'stress-ng' => ['stress-ng', 'tools', '0.17.06', 'ubuntu', null, false, [], [], ['stress-ng']],
        'nginx' => ['Nginx', 'web', '1.24.0', 'ubuntu', 'nginx', true, [], [], ['nginx']],
        'php8.3' => ['PHP 8.3 (FPM)', 'php', '8.3.6', 'ubuntu', null, true, [], [], ['php8.3-fpm', 'php8.3-cli', 'php8.3-common', 'php8.3-opcache', 'php8.3-mbstring', 'php8.3-xml', 'php8.3-curl', 'php8.3-zip']],
        'lego' => ['lego (ACME)', 'web', '4.9.1', 'ubuntu', null, false, [], [], ['lego']],
        'fail2ban' => ['Fail2ban', 'security', '1.0.2', 'ubuntu', 'fail2ban', true, [], [], ['fail2ban']],
        'clamav' => ['ClamAV', 'security', '1.0.8', 'ubuntu', 'clamav-daemon', false, [], [], ['clamav', 'clamav-daemon', 'clamav-freshclam']],
        'yara' => ['YARA', 'security', '4.5.0', 'ubuntu', null, false, [], [], ['yara']],
        'modsecurity' => ['ModSecurity + CRS', 'security', '3.0.12', 'ubuntu', null, false, [], [], ['libnginx-mod-http-modsecurity', 'modsecurity-crs']],
        'php8.1' => ['PHP 8.1 (FPM)', 'php', '8.1.31', 'ppa-ondrej-php', null, false, [], [], ['php8.1-fpm', 'php8.1-cli', 'php8.1-common']],
        'php8.2' => ['PHP 8.2 (FPM)', 'php', '8.2.27', 'ppa-ondrej-php', null, false, [], [], ['php8.2-fpm', 'php8.2-cli', 'php8.2-common']],
        'php8.4' => ['PHP 8.4 (FPM)', 'php', '8.4.2', 'ppa-ondrej-php', null, false, [], [], ['php8.4-fpm', 'php8.4-cli', 'php8.4-common']],
        'redis' => ['Redis', 'cache', '7.0.15', 'ubuntu', 'redis-server', false, ['valkey'], [], ['redis-server']],
        'valkey' => ['Valkey', 'cache', '7.2.8', 'ubuntu', 'valkey-server', false, ['redis'], [], ['valkey-server']],
        'memcached' => ['Memcached', 'cache', '1.6.24', 'ubuntu', 'memcached', false, [], [], ['memcached']],
        'nodejs' => ['Node.js (runtime)', 'runtime', '18.19.1', 'ubuntu', null, false, [], [], ['nodejs']],
        'composer' => ['Composer', 'tools', '2.7.1', 'ubuntu', null, false, [], ['php8.3'], ['composer']],
        'wp-cli' => ['WP-CLI', 'tools', '2.11.0', 'itso', null, false, [], ['php8.3'], []],
        'docker' => ['Docker Engine + Compose', 'docker', '27.5.1', 'ubuntu', 'docker', false, [], [], ['docker.io', 'docker-compose-v2']],
    ];

    public function run(): void
    {
        foreach (self::RECIPES as $key => [$name, $category, $version, $source, $service, $core, $conflicts, $requires, $packages]) {
            SoftwareCatalog::query()->updateOrCreate(['key' => $key], ['name' => $name, 'category' => $category,
                'versions' => [$version], 'source' => $source, 'service' => $service, 'core' => $core,
                'conflicts' => $conflicts, 'requires' => $requires, 'packages' => $packages]);
        }
    }
}
