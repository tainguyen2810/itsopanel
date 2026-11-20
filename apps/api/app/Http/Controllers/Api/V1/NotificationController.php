<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Http\Support\Listing;
use App\Models\Notification;
use App\Models\User;
use App\Support\PublicId;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/** Thông báo in-app của chính user (admin và portal dùng chung). */
final class NotificationController
{
    public function index(Request $request): JsonResponse
    {
        $q = Notification::query()->where('user_id', $this->user($request)->id);
        Listing::search($request, $q, ['notifications.title', 'notifications.body']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'notifications.created_at'], '-created_at',
            fn (Notification $n): array => self::present($n)));
    }

    public function read(Request $request, string $id): Response
    {
        $nid = PublicId::decode('notification', $id);
        $n = $nid !== null ? Notification::query()->where('user_id', $this->user($request)->id)->find($nid) : null;
        if (! $n instanceof Notification) {
            throw new NotFoundHttpException;
        }
        if ($n->read_at === null) {
            $n->read_at = Carbon::now();
            $n->save();
        }

        return response()->noContent();
    }

    public function readAll(Request $request): Response
    {
        Notification::query()->where('user_id', $this->user($request)->id)->whereNull('read_at')
            ->update(['read_at' => Carbon::now()]);

        return response()->noContent();
    }

    /** @return array<string, mixed> */
    public static function present(Notification $n): array
    {
        $data = is_array($n->data) ? $n->data : [];
        $sev = $data['severity'] ?? 'info';
        $link = $data['link'] ?? null;

        return [
            'uuid' => PublicId::encode('notification', $n->id),
            'type' => $n->type,
            'severity' => in_array($sev, ['info', 'low', 'medium', 'high', 'critical'], true) ? $sev : 'info',
            'title' => $n->title,
            'body' => (string) $n->body,
            'link' => is_string($link) ? $link : null,
            'read_at' => $n->read_at?->toIso8601String(),
            'created_at' => $n->created_at->toIso8601String(),
        ];
    }

    private function user(Request $request): User
    {
        $u = $request->user();
        abort_unless($u instanceof User, 401);

        return $u;
    }
}
