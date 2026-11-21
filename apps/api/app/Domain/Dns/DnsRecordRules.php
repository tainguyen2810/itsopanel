<?php

declare(strict_types=1);

namespace App\Domain\Dns;

use App\Exceptions\ApiProblem;

/** Kiểm nội dung bản ghi DNS theo loại (ngoài kiểm cú pháp chung của DnsRecordInput). */
final class DnsRecordRules
{
    private const HOST = '/^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/';

    /**
     * @param  array<string, mixed>  $in
     * @return array{type: string, name: string, content: string, ttl: int, proxied: bool, priority?: int}
     */
    public static function normalize(array $in): array
    {
        $type = (string) ($in['type'] ?? '');
        $name = strtolower((string) ($in['name'] ?? ''));
        $content = trim((string) ($in['content'] ?? ''));
        $ttl = (int) ($in['ttl'] ?? 300);
        $proxied = (bool) ($in['proxied'] ?? false);
        $prio = isset($in['priority']) ? (int) $in['priority'] : null;
        if (! in_array($type, DnsService::TYPES, true)) {
            throw ApiProblem::field('type', 'Loại bản ghi không hỗ trợ.');
        }
        if (preg_match('/^(@|\*|[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?)*)$/', $name) !== 1) {
            throw ApiProblem::field('name', 'Tên bản ghi tương đối với zone (@ là gốc).');
        }
        if ($ttl < 60 || $ttl > 86400) {
            throw ApiProblem::field('ttl', 'TTL 60–86400 giây.');
        }
        if (strlen($content) === 0 || strlen($content) > 2048 || preg_match('/[\x00-\x1f\x7f]/', $content) === 1) {
            throw ApiProblem::field('content', 'Nội dung trống, quá dài hoặc có ký tự điều khiển.');
        }
        $ok = match ($type) {
            'A' => filter_var($content, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false,
            'AAAA' => filter_var($content, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false,
            'CNAME', 'NS', 'MX' => preg_match(self::HOST, strtolower($content)) === 1,
            'SRV' => preg_match('/^[0-9]{1,5} [0-9]{1,5} ([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/', strtolower($content)) === 1,
            'CAA' => preg_match('/^(0|128) (issue|issuewild|iodef) "[^"\\\\]{1,255}"$/', $content) === 1,
            'TXT' => true,
        };
        if (! $ok) {
            throw ApiProblem::field('content', "Nội dung không đúng dạng bản ghi $type.");
        }
        if (in_array($type, ['CNAME', 'NS', 'MX', 'SRV'], true)) {
            $content = strtolower(rtrim($content, '.'));
        }
        if (in_array($type, ['MX', 'SRV'], true) && $prio === null) {
            throw ApiProblem::field('priority', "Bản ghi $type cần priority.");
        }
        if ($proxied && ! in_array($type, ['A', 'AAAA', 'CNAME'], true)) {
            throw ApiProblem::field('proxied', 'Chỉ A, AAAA, CNAME đi qua proxy Cloudflare được.');
        }
        $out = ['type' => $type, 'name' => $name, 'content' => $content, 'ttl' => $ttl, 'proxied' => $proxied];
        if (in_array($type, ['MX', 'SRV'], true)) {
            $out['priority'] = (int) $prio;
        }

        return $out;
    }
}
