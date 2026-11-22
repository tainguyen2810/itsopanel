<?php

declare(strict_types=1);

namespace App\Http\Presenters;

use App\Models\NotificationChannel;
use App\Models\NotificationDelivery;

/** Kênh thông báo và lượt gửi (schema NotificationChannel / NotificationDelivery). Không bao giờ trả bí mật. */
final class NotificationPresenter
{
    /** @return array<string, mixed> */
    public function channel(NotificationChannel $c): array
    {
        $last = NotificationDelivery::query()->where('channel_id', $c->id)->orderByDesc('id')->first();
        $cfg = $c->config;

        return ['uuid' => $c->uuid, 'type' => $c->type, 'name' => $c->name, 'enabled' => $c->enabled,
            'config' => [
                'recipients' => $c->type === 'email' ? array_values((array) ($cfg['recipients'] ?? [])) : [],
                'chat_id' => $c->type === 'telegram' ? ($cfg['chat_id'] ?? null) : null,
                'url' => $c->type === 'webhook' ? ($cfg['url'] ?? null) : null,
                'allow_private_network' => $c->type === 'webhook' && ($cfg['allow_private_network'] ?? false) === true,
            ],
            'secret_set' => $c->secret_encrypted !== null,
            'last_delivery' => $last === null ? null : ['state' => $last->state, 'at' => ($last->sent_at ?? $last->updated_at)->toIso8601String(),
                'error' => $last->error],
            'created_at' => $c->created_at->toIso8601String(), 'updated_at' => $c->updated_at->toIso8601String()];
    }

    public static function channelEtag(NotificationChannel $c): string
    {
        return '"'.sha1(json_encode([$c->uuid, $c->name, $c->enabled, $c->config, sha1((string) $c->secret_encrypted)],
            JSON_THROW_ON_ERROR)).'"';
    }

    /** @return array<string, mixed> */
    public function delivery(NotificationDelivery $d): array
    {
        $c = $d->channel;

        return ['uuid' => $d->uuid,
            'channel' => ['uuid' => (string) $c?->uuid, 'name' => (string) $c?->name, 'type' => $c->type ?? 'email'],
            'event_type' => $d->event_type, 'title' => $d->title, 'severity' => $d->severity, 'state' => $d->state,
            'attempts' => $d->attempts, 'error' => $d->error, 'response_code' => $d->response_code,
            'created_at' => $d->created_at->toIso8601String(), 'sent_at' => $d->sent_at?->toIso8601String(),
            'next_retry_at' => $d->next_retry_at?->toIso8601String()];
    }
}
