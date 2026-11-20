<?php

declare(strict_types=1);

namespace App\Auth;

use App\Models\MfaCredential;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * MFA TOTP + mã khôi phục (D-58). Secret TOTP mã hóa bằng APP_KEY trong `mfa_credentials.secret_encrypted`;
 * mã khôi phục lưu một hàng `type=recovery` chứa danh sách băm argon2id (đã mã hóa), dùng xong xóa khỏi danh sách.
 */
final class MfaService
{
    public function totp(User $user): ?MfaCredential
    {
        return MfaCredential::query()->where('user_id', $user->id)->where('type', 'totp')->first();
    }

    public function enabled(User $user): bool
    {
        return MfaCredential::query()->where('user_id', $user->id)->where('type', 'totp')->exists();
    }

    /** @return list<'totp'|'recovery'> */
    public function methods(User $user): array
    {
        $types = MfaCredential::query()->where('user_id', $user->id)->pluck('type')->all();
        $out = [];
        if (in_array('totp', $types, true)) {
            $out[] = 'totp';
            if (in_array('recovery', $types, true) && $this->recoveryHashes($user) !== []) {
                $out[] = 'recovery';
            }
        }

        return $out;
    }

    /**
     * Tạo secret + mã khôi phục mới (chưa lưu DB tới khi xác nhận).
     *
     * @return array{secret: string, codes: list<string>, pending: array{secret: string, hashes: list<string>}}
     */
    public function startEnrollment(): array
    {
        $secret = Totp::generateSecret();
        $n = (int) config('itso.auth.recovery_codes', 10);
        $codes = [];
        for ($i = 0; $i < $n; $i++) {
            $codes[] = strtolower(Str::random(10));
        }

        return [
            'secret' => $secret,
            'codes' => $codes,
            'pending' => [
                'secret' => Crypt::encryptString($secret),
                'hashes' => array_map(fn (string $c): string => Hash::make($c), $codes),
            ],
        ];
    }

    /**
     * Xác nhận đăng ký: mã phải khớp secret đang chờ. Trả false nếu sai.
     *
     * @param  array{secret: string, hashes: list<string>}  $pending
     */
    public function confirmEnrollment(User $user, array $pending, string $code): bool
    {
        $secret = Crypt::decryptString($pending['secret']);
        $step = Totp::match($secret, $code, Carbon::now()->getTimestamp());
        if ($step === null) {
            return false;
        }
        DB::transaction(function () use ($user, $pending, $step): void {
            MfaCredential::query()->where('user_id', $user->id)->whereIn('type', ['totp', 'recovery'])->delete();
            MfaCredential::query()->create([
                'user_id' => $user->id, 'type' => 'totp', 'label' => 'Authenticator',
                'secret_encrypted' => $pending['secret'],
                'last_used_at' => Carbon::createFromTimestamp($step * 30),
            ]);
            MfaCredential::query()->create([
                'user_id' => $user->id, 'type' => 'recovery', 'label' => 'Recovery codes',
                'secret_encrypted' => Crypt::encryptString(json_encode($pending['hashes'], JSON_THROW_ON_ERROR)),
            ]);
        });

        return true;
    }

    /** Kiểm mã TOTP hoặc mã khôi phục của user; chặn dùng lại cùng bước TOTP; mã khôi phục dùng một lần. */
    public function verify(User $user, string $method, string $code): bool
    {
        return $method === 'recovery' ? $this->useRecovery($user, $code) : $this->verifyTotp($user, $code);
    }

    private function verifyTotp(User $user, string $code): bool
    {
        return DB::transaction(function () use ($user, $code): bool {
            $cred = MfaCredential::query()->where('user_id', $user->id)->where('type', 'totp')->lockForUpdate()->first();
            if ($cred === null) {
                return false;
            }
            $step = Totp::match(Crypt::decryptString($cred->secret_encrypted), $code, Carbon::now()->getTimestamp());
            $last = $cred->last_used_at !== null ? Totp::timestep($cred->last_used_at->getTimestamp()) : -1;
            if ($step === null || $step <= $last) {
                return false;
            }
            $cred->last_used_at = Carbon::createFromTimestamp($step * 30);
            $cred->save();

            return true;
        });
    }

    private function useRecovery(User $user, string $code): bool
    {
        if (preg_match('/^[a-z0-9]{10}$/', $code) !== 1) {
            return false;
        }

        return DB::transaction(function () use ($user, $code): bool {
            $cred = MfaCredential::query()->where('user_id', $user->id)->where('type', 'recovery')->lockForUpdate()->first();
            if ($cred === null) {
                return false;
            }
            $hashes = $this->decodeHashes($cred);
            foreach ($hashes as $i => $h) {
                if (Hash::check($code, $h)) {
                    unset($hashes[$i]);
                    $cred->secret_encrypted = Crypt::encryptString(json_encode(array_values($hashes), JSON_THROW_ON_ERROR));
                    $cred->last_used_at = Carbon::now();
                    $cred->save();

                    return true;
                }
            }

            return false;
        });
    }

    /** @return list<string> */
    private function recoveryHashes(User $user): array
    {
        $cred = MfaCredential::query()->where('user_id', $user->id)->where('type', 'recovery')->first();

        return $cred === null ? [] : $this->decodeHashes($cred);
    }

    /** @return list<string> */
    private function decodeHashes(MfaCredential $cred): array
    {
        $list = json_decode(Crypt::decryptString($cred->secret_encrypted), true);

        return is_array($list) ? array_values(array_filter($list, 'is_string')) : [];
    }
}
