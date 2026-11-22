<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Domain\Audit\AuditLogger;
use App\Domain\Notifications\NotificationCatalog;
use App\Domain\Notifications\NotificationPreferences;
use App\Exceptions\ApiProblem;
use App\Http\Support\OffsetPage;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Danh mục sự kiện và tùy chọn thông báo của chính người gọi (cả hai realm, ADR 0049).
 * Portal: chỉ sự kiện có USER trong đối tượng, kênh in_app + email.
 */
final class NotificationPreferenceController
{
    public function __construct(private readonly NotificationPreferences $prefs, private readonly AuditLogger $audit) {}

    public function events(Request $request): JsonResponse
    {
        /** @var User $u */
        $u = $request->user();

        return response()->json(OffsetPage::ofArray($request, NotificationCatalog::list($u->realm !== 'admin')));
    }

    public function show(Request $request): JsonResponse
    {
        /** @var User $u */
        $u = $request->user();
        $p = $this->prefs->get($u);

        return response()->json(['data' => $p])->header('ETag', NotificationPreferences::etag($p));
    }

    public function update(Request $request): JsonResponse
    {
        /** @var User $u */
        $u = $request->user();
        $m = $request->header('If-Match');
        if (is_string($m) && $m !== '' && $m !== NotificationPreferences::etag($this->prefs->get($u))) {
            throw new ApiProblem(412, 'precondition_failed', 'Tùy chọn đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        $p = $this->prefs->update($u, $request->json()->all());
        $this->audit->record('notification_preferences.update', $u, ['channels' => $p['channels']]);

        return response()->json(['data' => $p])->header('ETag', NotificationPreferences::etag($p));
    }
}
