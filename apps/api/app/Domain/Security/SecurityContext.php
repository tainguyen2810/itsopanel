<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Domain\Setup\SetupWizard;
use App\Models\SecuritySetting;
use App\Models\Server;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/** Dữ kiện dùng chung: cổng SSH/panel hiện tại, allowlist Admin, actor cho requested_by. */
final class SecurityContext
{
    public static function sshPort(Server $s): int
    {
        $set = SecuritySetting::query()->find($s->id);
        $p = $set?->ssh['port'] ?? $set?->audit_facts['sshd']['port'] ?? 22;

        return is_numeric($p) && (int) $p >= 1 && (int) $p <= 65535 ? (int) $p : 22;
    }

    public static function panelPort(): int
    {
        $access = app(SetupWizard::class)->get('access');
        $p = is_array($access) ? (int) ($access['panel_port'] ?? 0) : 0;

        return $p >= 1 && $p <= 65535 ? $p : (int) config('itso.security.panel_port', 8443);
    }

    /** @return list<string> CIDR của allowlist scope admin */
    public static function adminAllowlist(): array
    {
        return array_values(array_map(fn ($c): string => (string) $c,
            DB::table('ip_allowlist')->where('scope', 'admin')->orderBy('id')->pluck('cidr')->all()));
    }

    /** @return array{user_uuid: string|null, role: string} */
    public static function by(?User $u): array
    {
        return $u instanceof User ? ['user_uuid' => $u->uuid, 'role' => $u->roleKey() ?? 'SYSTEM']
            : ['user_uuid' => null, 'role' => 'SYSTEM'];
    }
}
