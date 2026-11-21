<?php

declare(strict_types=1);

namespace App\Domain\Web;

/** PHP Phase 5 (D-68): chỉ 8.3 từ kho Ubuntu 24.04; extension theo allowlist của agent (`PhpExtension`). */
final class PhpCatalog
{
    public const DEFAULT = '8.3';

    /** @var list<string> */
    public const SUPPORTED = ['8.3'];

    /** @var list<string> */
    public const EXTENSIONS = ['bcmath', 'curl', 'gd', 'imagick', 'intl', 'mbstring', 'mysql', 'opcache', 'pgsql', 'redis',
        'soap', 'sqlite3', 'xml', 'zip'];

    /** Extension cài kèm khi cài PHP (wizard bước 4, PHP Manager). */
    public const BASE_EXTENSIONS = ['curl', 'intl', 'mbstring', 'opcache', 'xml', 'zip'];

    public static function supported(string $v): bool
    {
        return in_array($v, self::SUPPORTED, true);
    }
}
