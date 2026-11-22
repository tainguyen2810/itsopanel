<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Domain\Audit\AuditLogger;
use App\Domain\Notifications\NotificationDispatcher;
use App\Domain\Notifications\NotificationSender;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\NotificationPresenter;
use App\Http\Support\Listing;
use App\Models\NotificationChannel;
use App\Models\NotificationDelivery;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Kênh thông báo (email nhóm, Telegram, webhook) và nhật ký gửi — chỉ SUPER_ADMIN (monitoring.manage), D-103 / ADR 0048.
 * Bí mật chỉ ghi: response, audit và delivery không bao giờ chứa bí mật. SSRF guard kiểm khi gửi (DNS có thể đổi).
 */
final class NotificationChannelController
{
    public const CHAT_ID = '/^-?[0-9]{1,20}$|^@[A-Za-z0-9_]{5,32}$/';

    public function __construct(
        private readonly NotificationPresenter $present,
        private readonly AuditLogger $audit,
        private readonly NotificationDispatcher $dispatcher,
        private readonly NotificationSender $sender,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $q = NotificationChannel::query();
        Listing::search($request, $q, ['notification_channels.name']);

        return response()->json(Listing::page($request, $q, ['name' => 'notification_channels.name',
            'created_at' => 'notification_channels.created_at', 'id' => 'notification_channels.id'], 'name',
            fn (NotificationChannel $c): array => $this->present->channel($c)));
    }

    public function store(Request $request): JsonResponse
    {
        $in = $request->json()->all();
        $this->only($in, ['type', 'name', 'enabled', 'config', 'secret']);
        $type = $in['type'] ?? null;
        if (! is_string($type) || ! in_array($type, ['email', 'telegram', 'webhook'], true)) {
            throw ApiProblem::field('type', 'Chọn loại kênh: email, telegram hoặc webhook.');
        }
        $name = $this->name($in['name'] ?? null);
        if (NotificationChannel::query()->where('name', $name)->exists()) {
            throw ApiProblem::conflict('Đã có kênh cùng tên.');
        }
        $cfg = $this->config($type, is_array($in['config'] ?? null) ? $in['config'] : null, []);
        $secret = $this->secret($in, $type !== 'email');
        $c = new NotificationChannel(['type' => $type, 'name' => $name, 'config' => $cfg,
            'enabled' => $this->bool($in, 'enabled') ?? true]);
        $c->setSecret($type === 'email' ? null : $secret);
        /** @var User $actor */
        $actor = $request->user();
        $c->created_by_user_id = $actor->id;
        $c->save();
        $c->refresh();
        $this->audit->record('notification_channel.create', $c, ['type' => $type, 'name' => $name,
            'secret' => $secret !== null ? '[REDACTED]' : null]);

        return response()->json(['data' => $this->present->channel($c)], 201)->header('ETag', NotificationPresenter::channelEtag($c));
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $c = $this->find($id);
        $m = $request->header('If-Match');
        if (is_string($m) && $m !== '' && $m !== NotificationPresenter::channelEtag($c)) {
            throw new ApiProblem(412, 'precondition_failed', 'Kênh đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        $in = $request->json()->all();
        $this->only($in, ['name', 'enabled', 'config', 'secret']);
        $changes = [];
        if (array_key_exists('name', $in)) {
            $name = $this->name($in['name']);
            if (NotificationChannel::query()->where('name', $name)->whereKeyNot($c->id)->exists()) {
                throw ApiProblem::conflict('Đã có kênh cùng tên.');
            }
            if ($name !== $c->name) {
                $changes['name'] = [$c->name, $name];
            }
            $c->name = $name;
        }
        if (($enabled = $this->bool($in, 'enabled')) !== null) {
            if ($enabled !== $c->enabled) {
                $changes['enabled'] = [$c->enabled, $enabled];
            }
            $c->enabled = $enabled;
        }
        if (array_key_exists('config', $in)) {
            if (! is_array($in['config'])) {
                throw ApiProblem::field('config', 'Cấu hình không hợp lệ.');
            }
            $c->config = $this->config($c->type, $in['config'], $c->config);
            $changes['config'] = 'updated';
        }
        $secret = $this->secret($in, false);
        if ($secret !== null && $c->type !== 'email') {
            $c->setSecret($secret);
            $changes['secret'] = '[REDACTED]';
        }
        $c->save();
        $this->audit->record('notification_channel.update', $c, $changes);

        return response()->json(['data' => $this->present->channel($c->refresh())])->header('ETag', NotificationPresenter::channelEtag($c));
    }

    public function destroy(Request $request, string $id): Response
    {
        $c = $this->find($id);
        DB::transaction(function () use ($c): void {
            NotificationDelivery::query()->where('channel_id', $c->id)->update(['resend_of_id' => null]);
            NotificationDelivery::query()->where('channel_id', $c->id)->delete();
            DB::update('UPDATE alert_rules SET channel_ids = array_remove(channel_ids, ?::bigint) WHERE ?::bigint = ANY(channel_ids)',
                [$c->id, $c->id]);
            $c->delete();
        });
        $this->audit->record('notification_channel.delete', $c, ['name' => $c->name, 'type' => $c->type]);

        return response()->noContent();
    }

    /** Gửi đồng bộ một tin thử (không thử lại); địa chỉ bị SSRF guard chặn → delivery blocked. */
    public function test(Request $request, string $id): JsonResponse
    {
        $c = $this->find($id);
        $d = $this->dispatcher->toChannel($c, 'channel.test', 'Tin thử từ ITSO Panel', 'Kênh "'.$c->name.'" hoạt động.', 'info',
            null, null, ['test' => true], false);
        $d = $this->sender->attempt($d->id, false) ?? $d;
        $this->audit->record('notification_channel.test', $c, ['state' => $d->state], $d->state === 'sent' ? 'success' : 'failure');

        return response()->json(['data' => $this->present->delivery($d->refresh())]);
    }

    public function deliveries(Request $request): JsonResponse
    {
        $q = NotificationDelivery::query()->with('channel')->whereNotNull('channel_id');
        $state = $request->query('filter')['delivery_state'] ?? null;
        if ($state !== null) {
            if (! is_string($state) || ! in_array($state, ['queued', 'sending', 'sent', 'retrying', 'failed', 'blocked'], true)) {
                throw ApiProblem::field('filter[delivery_state]', 'Trạng thái không hợp lệ.');
            }
            $q->where('state', $state);
        }
        $ch = $request->query('filter')['channel'] ?? null;
        if ($ch !== null) {
            if (! is_string($ch) || ! Str::isUuid($ch)) {
                throw ApiProblem::field('filter[channel]', 'Kênh không hợp lệ.');
            }
            $q->whereIn('channel_id', NotificationChannel::query()->where('uuid', $ch)->select('id'));
        }
        Listing::search($request, $q, ['notification_deliveries.title', 'notification_deliveries.event_type']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'notification_deliveries.created_at',
            'id' => 'notification_deliveries.id'], '-created_at', fn (NotificationDelivery $d): array => $this->present->delivery($d)));
    }

    /** Gửi lại lượt failed/blocked: tạo lượt mới (resend_of_id) vào queue. */
    public function resend(Request $request, string $id): JsonResponse
    {
        $d = Str::isUuid($id) ? NotificationDelivery::query()->where('uuid', $id)->whereNotNull('channel_id')->first() : null;
        if (! $d instanceof NotificationDelivery) {
            throw new NotFoundHttpException;
        }
        if (! in_array($d->state, ['failed', 'blocked'], true)) {
            throw ApiProblem::conflict('Chỉ gửi lại được lượt gửi lỗi hoặc bị chặn.');
        }
        $c = $d->channel;
        if (! $c instanceof NotificationChannel) {
            throw ApiProblem::conflict('Kênh đã bị xóa.');
        }
        $p = $d->payload;
        $new = $this->dispatcher->toChannel($c, $d->event_type, $d->title, (string) ($p['body'] ?? ''), $d->severity,
            is_string($p['link'] ?? null) ? $p['link'] : null, $d->alert_id, ['resend' => true]);
        NotificationDelivery::query()->whereKey($new->id)->update(['resend_of_id' => $d->id]);
        $this->audit->record('notification_delivery.resend', $c, ['delivery' => $d->uuid]);

        return response()->json(['data' => $this->present->delivery($new->refresh())]);
    }

    // ---------------------------------------------------------------- kiểm tra đầu vào

    private function find(string $id): NotificationChannel
    {
        $c = Str::isUuid($id) ? NotificationChannel::query()->where('uuid', $id)->first() : null;

        return $c instanceof NotificationChannel ? $c : throw new NotFoundHttpException;
    }

    /**
     * @param  array<string, mixed>  $in
     * @param  list<string>  $keys
     */
    private function only(array $in, array $keys): void
    {
        $unknown = array_diff(array_keys($in), $keys);
        if ($unknown !== []) {
            throw ApiProblem::field((string) reset($unknown), 'Trường không hợp lệ.');
        }
    }

    private function name(mixed $v): string
    {
        $v = is_string($v) ? trim($v) : '';
        if ($v === '' || mb_strlen($v) > 80 || preg_match('/[\x00-\x1f\x7f]/u', $v) === 1) {
            throw ApiProblem::field('name', 'Tên kênh từ 1 đến 80 ký tự.');
        }

        return $v;
    }

    /** @param  array<string, mixed>  $in */
    private function bool(array $in, string $k): ?bool
    {
        if (! array_key_exists($k, $in)) {
            return null;
        }

        return is_bool($in[$k]) ? $in[$k] : throw ApiProblem::field($k, 'Giá trị phải là true/false.');
    }

    /** @param  array<string, mixed>  $in */
    private function secret(array $in, bool $required): ?string
    {
        $s = $in['secret'] ?? null;
        if ($s === null) {
            return $required ? throw ApiProblem::field('secret', 'Nhập bot token / secret ký HMAC (16–512 ký tự).') : null;
        }
        if (! is_string($s) || strlen($s) < 16 || strlen($s) > 512 || preg_match('/[\x00-\x1f\x7f]/', $s) === 1) {
            throw ApiProblem::field('secret', 'Bí mật từ 16 đến 512 ký tự, không có ký tự điều khiển.');
        }

        return $s;
    }

    /**
     * @param  array<string, mixed>|null  $in
     * @param  array<string, mixed>  $cur
     * @return array<string, mixed>
     */
    private function config(string $type, ?array $in, array $cur): array
    {
        if ($in === null) {
            throw ApiProblem::field('config', 'Thiếu cấu hình kênh.');
        }
        $this->only($in, ['recipients', 'chat_id', 'url', 'allow_private_network']);
        $cfg = array_merge($cur, $in);
        if ($type === 'email') {
            $r = $cfg['recipients'] ?? null;
            if (! is_array($r) || ! array_is_list($r) || $r === [] || count($r) > 20) {
                throw ApiProblem::field('config.recipients', 'Nhập 1 đến 20 địa chỉ email hợp lệ.');
            }
            foreach ($r as $e) {
                if (! is_string($e) || mb_strlen($e) > 254 || filter_var($e, FILTER_VALIDATE_EMAIL) === false) {
                    throw ApiProblem::field('config.recipients', 'Nhập 1 đến 20 địa chỉ email hợp lệ.');
                }
            }

            return ['recipients' => array_values(array_unique($r))];
        }
        if ($type === 'telegram') {
            $chat = $cfg['chat_id'] ?? null;
            if (! is_string($chat) || preg_match(self::CHAT_ID, $chat) !== 1) {
                throw ApiProblem::field('config.chat_id', 'Chat ID là số (nhóm bắt đầu bằng -100) hoặc @tên_kênh.');
            }

            return ['chat_id' => $chat];
        }
        $url = $cfg['url'] ?? null;
        $private = $cfg['allow_private_network'] ?? false;
        if (! is_bool($private)) {
            throw ApiProblem::field('config.allow_private_network', 'Giá trị phải là true/false.');
        }
        $p = is_string($url) ? parse_url($url) : false;
        $scheme = is_array($p) ? strtolower($p['scheme'] ?? '') : '';
        if (! is_string($url) || strlen($url) > 500 || ! is_array($p) || ! isset($p['host']) || isset($p['user']) || isset($p['pass'])
            || ! in_array($scheme, ['http', 'https'], true) || preg_match('/[\s\x00-\x1f]/', $url) === 1) {
            throw ApiProblem::field('config.url', 'URL bắt đầu bằng https:// (tối đa 500 ký tự).');
        }
        if ($scheme === 'http' && ! $private) {
            throw ApiProblem::field('config.url', 'Chỉ dùng https://; http:// chỉ cho mạng riêng khi bật tùy chọn.');
        }

        return ['url' => $url, 'allow_private_network' => $private];
    }
}
