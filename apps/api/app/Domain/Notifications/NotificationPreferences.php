<?php

declare(strict_types=1);

namespace App\Domain\Notifications;

use App\Exceptions\ApiProblem;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Tùy chọn thông báo người × sự kiện × kênh (D-104, ADR 0049 §2–3). Bảng notification_preferences: một dòng mỗi sự kiện,
 * dòng event_type = '*' giữ danh sách kênh đang bật chung. Mặc định: chỉ in-app; mức critical luôn có in-app.
 * USER (realm portal) chỉ có in_app + email của chính mình; telegram là kênh realm admin.
 */
final class NotificationPreferences
{
    public const GLOBAL = '*';

    /** @return list<string> */
    public static function allowed(User $u): array
    {
        return $u->realm === 'admin' ? NotificationCatalog::PERSONAL : NotificationCatalog::PORTAL_CHANNELS;
    }

    /** @return array<string, list<string>> */
    private function rows(User $u): array
    {
        $out = [];
        foreach (DB::table('notification_preferences')->where('user_id', $u->id)->get() as $r) {
            $v = trim((string) $r->channels, '{}');
            $out[(string) $r->event_type] = $v === '' ? [] : explode(',', $v);
        }

        return $out;
    }

    /** @return array{channels: array<string, bool>, events: array<string, list<string>>, updated_at: string} */
    public function get(User $u): array
    {
        $rows = $this->rows($u);
        $allowed = self::allowed($u);
        $on = $rows[self::GLOBAL] ?? $allowed;
        $channels = [];
        foreach ($allowed as $c) {
            $channels[$c] = in_array($c, $on, true);
        }
        $events = [];
        foreach (NotificationCatalog::list($u->realm !== 'admin') as $e) {
            $sel = array_values(array_intersect($rows[$e['type']] ?? ['in_app'], $e['channels'], $allowed));
            if ($e['in_app_locked'] && ! in_array('in_app', $sel, true)) {
                array_unshift($sel, 'in_app');
            }
            $events[$e['type']] = $sel;
        }
        $at = DB::table('notification_preferences')->where('user_id', $u->id)->max('updated_at');

        return ['channels' => $channels, 'events' => $events,
            'updated_at' => Carbon::parse((string) ($at ?? $u->created_at))->toIso8601String()];
    }

    /** @param  array<string, mixed>  $prefs */
    public static function etag(array $prefs): string
    {
        return '"'.sha1(json_encode($prefs, JSON_THROW_ON_ERROR)).'"';
    }

    /**
     * @param  array<string, mixed>  $in  {channels?: {kênh: bool}, events?: {loại: list<kênh>}}
     * @return array{channels: array<string, bool>, events: array<string, list<string>>, updated_at: string}
     */
    public function update(User $u, array $in): array
    {
        $allowed = self::allowed($u);
        $catalog = [];
        foreach (NotificationCatalog::list($u->realm !== 'admin') as $e) {
            $catalog[$e['type']] = $e;
        }
        $unknown = array_diff(array_keys($in), ['channels', 'events', 'updated_at']);
        if ($unknown !== []) {
            throw ApiProblem::field((string) reset($unknown), 'Trường không hợp lệ.');
        }
        $write = [];
        if (array_key_exists('channels', $in)) {
            if (! is_array($in['channels'])) {
                throw ApiProblem::field('channels', 'Kênh không hợp lệ.');
            }
            $cur = $this->get($u)['channels'];
            foreach ($in['channels'] as $c => $v) {
                if (! in_array($c, $allowed, true) || ! is_bool($v)) {
                    throw ApiProblem::field("channels.$c", 'Kênh này không có cho tài khoản của bạn.');
                }
                $cur[$c] = $v;
            }
            $write[self::GLOBAL] = array_keys(array_filter($cur));
        }
        if (array_key_exists('events', $in)) {
            if (! is_array($in['events'])) {
                throw ApiProblem::field('events', 'Sự kiện không hợp lệ.');
            }
            foreach ($in['events'] as $type => $chs) {
                if (! is_string($type) || ! isset($catalog[$type])) {
                    throw ApiProblem::field("events.$type", 'Sự kiện không có hoặc không dành cho tài khoản này.');
                }
                if (! is_array($chs) || ! array_is_list($chs)) {
                    throw ApiProblem::field("events.$type", 'Danh sách kênh không hợp lệ.');
                }
                foreach ($chs as $c) {
                    if (! is_string($c) || ! in_array($c, $allowed, true) || ! in_array($c, $catalog[$type]['channels'], true)) {
                        throw ApiProblem::field("events.$type", 'Kênh '.(is_string($c) ? $c : '?').' không dùng được cho sự kiện này.');
                    }
                }
                $chs = array_values(array_unique($chs));
                if ($catalog[$type]['in_app_locked'] && ! in_array('in_app', $chs, true)) {
                    throw ApiProblem::field("events.$type", 'Sự kiện mức nghiêm trọng luôn có thông báo trong ứng dụng.');
                }
                $write[$type] = $chs;
            }
        }
        $now = Carbon::now();
        DB::transaction(function () use ($write, $u, $now): void {
            foreach ($write as $type => $chs) {
                DB::table('notification_preferences')->upsert(['user_id' => $u->id, 'event_type' => $type,
                    'channels' => '{'.implode(',', $chs).'}', 'updated_at' => $now], ['user_id', 'event_type'], ['channels', 'updated_at']);
            }
        });

        return $this->get($u);
    }

    /**
     * Kênh cá nhân hiệu lực cho một thông báo: tùy chọn ∩ kênh cho phép của sự kiện ∩ kênh đang bật; critical luôn in-app.
     * Loại không có trong danh mục → chỉ in-app (hành vi cũ).
     *
     * @return list<string>
     */
    public function effective(User $u, string $type, string $severity): array
    {
        $key = NotificationCatalog::key($type);
        if ($key === null) {
            return ['in_app'];
        }
        $rows = $this->rows($u);
        $allowed = self::allowed($u);
        $on = $rows[self::GLOBAL] ?? $allowed;
        $sel = array_values(array_intersect($rows[$key] ?? ['in_app'], NotificationCatalog::EVENTS[$key]['channels'], $allowed, $on));
        if (($severity === 'critical' || NotificationCatalog::inAppLocked($key)) && ! in_array('in_app', $sel, true)) {
            $sel[] = 'in_app';
        }

        return $sel;
    }
}
