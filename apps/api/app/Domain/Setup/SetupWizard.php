<?php

declare(strict_types=1);

namespace App\Domain\Setup;

use App\Domain\Web\ServerWebService;
use App\Exceptions\ApiProblem;
use App\Models\Server;
use App\Models\Setting;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Trạng thái wizard cài đặt lần đầu (module 30, Prompt 4.5). Lưu ở settings nhóm `setup`:
 * installed_at, code_sha256 (mã đã dùng), admin_user_id, locale, timezone, access.
 *
 * Mã thiết lập do "sudo itso setup-code" sinh: agent chỉ ghi sha256 + hạn vào config('itso.setup_code_file');
 * Laravel chỉ đọc file đó (không chạy lệnh) và đánh dấu đã dùng trong DB, nên mỗi mã dùng đúng một lần.
 */
final class SetupWizard
{
    public const GROUP = 'setup';

    public const SESSION_VERIFIED = 'itso.setup_verified';

    public function installed(): bool
    {
        if ($this->get('installed_at') !== null) {
            return true;
        }
        // Panel đã có SUPER_ADMIN không do wizard tạo (cài từ bản cũ, seed demo, CLI) → coi như đã cài.
        $wizardAdmin = $this->get('admin_user_id');

        return User::query()->where('realm', 'admin')
            ->whereHas('roles', fn ($q) => $q->where('key', 'SUPER_ADMIN'))
            ->when(is_int($wizardAdmin), fn ($q) => $q->where('id', '!=', $wizardAdmin))
            ->exists();
    }

    public function ensureOpen(): void
    {
        if ($this->installed()) {
            throw new ApiProblem(410, 'setup_completed', 'Wizard đã khóa', 'Panel đã cài đặt xong; wizard không dùng lại được.');
        }
    }

    /**
     * Đối chiếu mã với file băm. Sai → 422; đã dùng/hết hạn/không có mã → 409.
     *
     * @return string sha256 của mã (gắn vào phiên)
     */
    public function verifyCode(string $code): string
    {
        $file = $this->codeFile();
        if ($file === null) {
            throw new ApiProblem(409, 'setup_code_expired', 'Chưa có mã thiết lập',
                'Chạy "sudo itso setup-code" trên server để tạo mã mới.');
        }
        $raw = strtoupper(str_replace('-', '', trim($code)));
        $sha = hash('sha256', $raw);
        if (! hash_equals($file['sha256'], $sha)) {
            throw ApiProblem::field('code', 'Mã thiết lập không đúng.');
        }
        if ($this->get('code_sha256') === $sha) {
            throw new ApiProblem(409, 'setup_code_used', 'Mã đã được dùng',
                'Mỗi mã chỉ dùng một lần. Chạy "sudo itso setup-code" để tạo mã mới.');
        }
        if (Carbon::parse($file['expires_at'])->isPast()) {
            throw new ApiProblem(409, 'setup_code_expired', 'Mã đã hết hạn', 'Chạy "sudo itso setup-code" để tạo mã mới.');
        }
        $this->put('code_sha256', $sha);

        return $sha;
    }

    /** Mã thiết lập sinh bởi "itso install --restore": wizard mở luồng khôi phục thảm họa (D-87). */
    public function restoreMode(): bool
    {
        return ($this->codeFile()['mode'] ?? '') === 'restore';
    }

    /** @return array{sha256: string, expires_at: string, mode: string}|null */
    private function codeFile(): ?array
    {
        $path = (string) config('itso.setup_code_file');
        if ($path === '' || ! is_file($path) || ! is_readable($path)) {
            return null;
        }
        $d = json_decode((string) file_get_contents($path), true);
        if (! is_array($d) || ! is_string($d['sha256'] ?? null) || preg_match('/^[0-9a-f]{64}$/', $d['sha256']) !== 1
            || ! is_string($d['expires_at'] ?? null)) {
            return null;
        }

        return ['sha256' => $d['sha256'], 'expires_at' => $d['expires_at'], 'mode' => is_string($d['mode'] ?? null) ? $d['mode'] : ''];
    }

    /** Phiên hiện tại đã xác minh mã đang có hiệu lực (mã cuối cùng được đánh dấu dùng). */
    public function sessionVerified(mixed $sessionSha): bool
    {
        return is_string($sessionSha) && $sessionSha !== '' && $this->get('code_sha256') === $sessionSha;
    }

    public function wizardAdmin(): ?User
    {
        $id = $this->get('admin_user_id');

        return is_int($id) ? User::query()->find($id) : null;
    }

    /** @return array<string, mixed> */
    public function status(bool $codeVerified, bool $mfaEnabled): array
    {
        if ($this->installed()) {
            return ['installed' => true, 'code_verified' => false, 'admin_created' => true, 'admin_mfa_enabled' => true,
                'locale' => $this->locale(), 'timezone' => $this->timezone(), 'access' => null, 'steps_done' => [], 'restore_mode' => false];
        }
        $admin = $this->wizardAdmin() !== null;
        $access = $this->get('access');
        $steps = [];
        if ($codeVerified) {
            $steps[] = 'code';
        }
        if ($codeVerified && $this->get('locale') !== null) {
            $steps[] = 'language';
        }
        if ($admin && $mfaEnabled) {
            $steps[] = 'admin';
        }
        if (is_array($access)) {
            $steps[] = 'access';
        }
        $server = self::localServer();
        if ($server !== null && app(ServerWebService::class)->stack($server)['ready']) {
            $steps[] = 'stack';
        }
        if ($this->get('quota_seen_at') !== null) {
            $steps[] = 'quota';
        }

        return ['installed' => false, 'code_verified' => $codeVerified, 'admin_created' => $admin,
            'admin_mfa_enabled' => $admin && $mfaEnabled, 'locale' => $this->locale(), 'timezone' => $this->timezone(),
            'access' => is_array($access) ? self::access($access) : null, 'steps_done' => $steps,
            'restore_mode' => ! $admin && $this->restoreMode()];
    }

    /**
     * jsonb không giữ thứ tự khóa: trả theo thứ tự schema SetupAccess.
     *
     * @param  array<array-key, mixed>  $a
     * @return array{panel_domain: string|null, panel_port: int, entrance_path: string|null, allowlist: list<string>}
     */
    private static function access(array $a): array
    {
        return ['panel_domain' => is_string($a['panel_domain'] ?? null) ? $a['panel_domain'] : null,
            'panel_port' => (int) ($a['panel_port'] ?? 0),
            'entrance_path' => is_string($a['entrance_path'] ?? null) ? $a['entrance_path'] : null,
            'allowlist' => array_values(array_map('strval', (array) ($a['allowlist'] ?? [])))];
    }

    /** Server cài panel (bước stack/quota của wizard): theo config, nếu không có thì server đầu tiên. */
    public static function localServer(): ?Server
    {
        return Server::query()->where('name', (string) config('itso.local_server.name'))->first()
            ?? Server::query()->orderBy('id')->first();
    }

    public function locale(): string
    {
        $l = $this->get('locale');

        return in_array($l, ['vi', 'en'], true) ? $l : 'vi';
    }

    public function timezone(): string
    {
        $tz = $this->get('timezone');

        return is_string($tz) ? $tz : (string) config('app.timezone', 'Asia/Ho_Chi_Minh');
    }

    public function complete(): void
    {
        DB::transaction(function (): void {
            $this->put('installed_at', Carbon::now()->toIso8601String());
        });
    }

    public function get(string $key): mixed
    {
        $s = Setting::query()->where('group_key', self::GROUP)->where('key', $key)->first();

        return $s?->value['v'] ?? null;
    }

    public function put(string $key, mixed $value, ?int $userId = null): void
    {
        Setting::query()->updateOrCreate(['group_key' => self::GROUP, 'key' => $key],
            ['value' => ['v' => $value], 'updated_by_user_id' => $userId]);
    }
}
