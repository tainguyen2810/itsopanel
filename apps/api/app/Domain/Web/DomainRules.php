<?php

declare(strict_types=1);

namespace App\Domain\Web;

use App\Domain\Setup\SetupWizard;
use App\Exceptions\ApiProblem;
use App\Models\WebsiteDomain;

/**
 * Kiểm tầng nghiệp vụ cho domain website (schema đã kiểm cú pháp): chữ thường punycode, không tên nội bộ,
 * không trùng domain của panel, không trùng domain đang hoạt động ở website khác. Agent kiểm lại lần nữa.
 */
final class DomainRules
{
    public const PATTERN = '/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$/';

    /** Hậu tố nội bộ (trùng validate.reservedDomainSuffix của agent). */
    public const RESERVED = ['localhost', 'localdomain', 'local', 'internal', 'invalid', 'test'];

    public function __construct(private readonly SetupWizard $wizard) {}

    public function check(string $name, string $field = 'name'): void
    {
        if (strlen($name) < 4 || strlen($name) > 253 || preg_match(self::PATTERN, $name) !== 1) {
            throw ApiProblem::field($field, 'Tên miền không hợp lệ (chữ thường, punycode, không wildcard).');
        }
        $labels = explode('.', $name);
        $tld = end($labels);
        foreach (self::RESERVED as $r) {
            if ($tld === $r || str_ends_with($name, '.'.$r)) {
                throw ApiProblem::field($field, 'Tên miền nội bộ (localhost, .local, .internal…) không dùng cho website.');
            }
        }
        foreach ($this->panelDomains() as $p) {
            if ($name === $p || str_ends_with($p, '.'.$name)) {
                throw ApiProblem::field($field, 'Tên miền đang dùng cho panel.');
            }
        }
        if (WebsiteDomain::query()->where('name', $name)->exists()) {
            throw ApiProblem::conflict("Domain {$name} đã gắn với một website.");
        }
    }

    /** @return list<string> */
    private function panelDomains(): array
    {
        $out = [];
        foreach ((array) config('itso.auth.hosts', []) as $h) {
            if (is_string($h) && $h !== '') {
                $out[] = strtolower($h);
            }
        }
        $access = $this->wizard->get('access');
        if (is_array($access) && is_string($access['panel_domain'] ?? null)) {
            $out[] = strtolower($access['panel_domain']);
        }

        return $out;
    }
}
