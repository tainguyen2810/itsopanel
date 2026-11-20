<?php

declare(strict_types=1);

namespace App\Auth;

use App\Models\User;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;

/**
 * Đọc/thu hồi phiên của user trong bảng `sessions`. Không lộ session id: `uuid` công khai là băm của id.
 */
final class SessionRepository
{
    public static function publicId(string $sessionId): string
    {
        $h = hash('sha256', 'itso-session:'.$sessionId);

        return sprintf('%s-%s-8%s-%s-%s', substr($h, 0, 8), substr($h, 8, 4), substr($h, 13, 3),
            substr($h, 16, 4), substr($h, 20, 12));
    }

    /**
     * Phiên còn hạn của user trong realm, mới hoạt động trước.
     *
     * @return list<array{id: string, uuid: string, ip: string, user_agent: string, last_active_at: Carbon, created_at: Carbon}>
     */
    public function forUser(User $user, string $realm): array
    {
        $minActivity = Carbon::now()->subMinutes((int) config('session.lifetime', 120))->getTimestamp();
        $rows = DB::table('sessions')->where('user_id', $user->id)->where('realm', $realm)
            ->where('last_activity', '>=', $minActivity)->orderByDesc('last_activity')->get();
        $out = [];
        foreach ($rows as $r) {
            $last = Carbon::createFromTimestamp((int) $r->last_activity);
            $created = $this->createdAt((string) $r->payload) ?? $last;
            $out[] = [
                'id' => (string) $r->id,
                'uuid' => self::publicId((string) $r->id),
                'ip' => (string) ($r->ip_address ?? ''),
                'user_agent' => (string) ($r->user_agent ?? ''),
                'last_active_at' => $last,
                'created_at' => $created,
            ];
        }

        return $out;
    }

    public function delete(string $sessionId): void
    {
        DB::table('sessions')->where('id', $sessionId)->delete();
    }

    /** Xóa mọi phiên của user (mọi realm), trừ phiên `$keep`. */
    public function deleteAllFor(User $user, ?string $keep = null): void
    {
        DB::table('sessions')->where('user_id', $user->id)
            ->when($keep !== null, fn ($q) => $q->where('id', '!=', $keep))->delete();
    }

    private function createdAt(string $payload): ?Carbon
    {
        $raw = base64_decode($payload, true);
        if ($raw === false) {
            return null;
        }
        $data = json_decode($raw, true);
        if (! is_array($data)) {
            try {
                $data = json_decode(Crypt::decryptString($raw), true);
            } catch (DecryptException) {
                return null;
            }
        }
        $v = is_array($data) ? ($data[SessionKeys::CREATED_AT] ?? null) : null;

        return is_string($v) ? Carbon::parse($v) : null;
    }
}
