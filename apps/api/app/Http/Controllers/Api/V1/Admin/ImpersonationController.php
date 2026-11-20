<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Auth\SessionKeys;
use App\Domain\Audit\AuditLogger;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\UserPresenter;
use App\Models\ImpersonationSession;
use App\Models\User;
use App\Support\PublicId;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Giả danh USER Portal (D-61): SUPER_ADMIN + step-up + lý do → impersonation_sessions + vé một lần (cache, 60 giây).
 * Portal đổi vé lấy phiên của USER đích (`POST /auth/impersonation:accept`); phiên tự hết hạn, ghi audit kèm người giả danh.
 */
final class ImpersonationController
{
    public function __construct(
        private readonly Access $access,
        private readonly UserPresenter $present,
        private readonly AuditLogger $audit,
    ) {}

    public static function publicId(int $id): string
    {
        return PublicId::encode('impersonation', $id);
    }

    public function start(Request $request, string $id): JsonResponse
    {
        /** @var User $staff */
        $staff = $request->user();
        $in = $request->validate(['reason' => ['required', 'string', 'min:5', 'max:500']]);
        $target = Str::isUuid($id) ? $this->access->users($staff)->where('users.uuid', $id)->first() : null;
        if (! $target instanceof User) {
            throw new NotFoundHttpException;
        }
        if ($target->realm !== 'portal' || $target->roleKey() !== 'USER') {
            throw ApiProblem::field('id', 'Chỉ giả danh được USER Portal.');
        }
        if ($target->status !== 'active') {
            throw ApiProblem::conflict('USER đang bị khóa hoặc vô hiệu hóa.');
        }
        $now = Carbon::now();
        $imp = ImpersonationSession::query()->create([
            'staff_user_id' => $staff->id, 'target_user_id' => $target->id, 'reason' => trim((string) $in['reason']),
            'started_at' => $now, 'expires_at' => $now->copy()->addMinutes((int) config('itso.auth.impersonation_minutes', 30)),
        ]);
        $ticket = Str::random(48);
        Cache::put(self::ticketKey($ticket), $imp->id, now()->addSeconds((int) config('itso.auth.impersonation_ticket_seconds', 60)));
        $this->audit->record('user.impersonate', $target, ['reason' => $imp->reason, 'expires_at' => $imp->expires_at->toIso8601String()]);
        $portal = rtrim((string) config('itso.auth.app_urls.portal'), '/');

        return response()->json(['data' => [
            'uuid' => self::publicId($imp->id),
            'staff' => $this->present->ref($staff),
            'target' => $this->present->ref($target),
            'reason' => $imp->reason,
            'started_at' => $imp->started_at->toIso8601String(),
            'expires_at' => $imp->expires_at->toIso8601String(),
            'portal_url' => $portal.'/impersonate?'.http_build_query(['ticket' => $ticket]),
        ]], 201);
    }

    /** Portal: đổi vé lấy phiên giả danh. */
    public function accept(Request $request): JsonResponse
    {
        $in = $request->validate(['ticket' => ['required', 'string', 'min:32', 'max:200']]);
        $impId = Cache::pull(self::ticketKey((string) $in['ticket']));
        $imp = is_int($impId) ? ImpersonationSession::query()->find($impId) : null;
        if ($imp === null || $imp->ended_at !== null || $imp->expires_at->isPast()) {
            throw ApiProblem::field('ticket', 'Vé giả danh không hợp lệ hoặc đã hết hạn.');
        }
        /** @var User|null $target */
        $target = User::query()->whereKey($imp->target_user_id)->where('realm', 'portal')->where('status', 'active')->first();
        if ($target === null) {
            throw ApiProblem::field('ticket', 'Vé giả danh không hợp lệ hoặc đã hết hạn.');
        }
        Auth::guard('web')->login($target);
        $session = $request->session();
        $session->put(SessionKeys::CREATED_AT, Carbon::now()->toIso8601String());
        $session->put(SessionKeys::IMPERSONATION_ID, $imp->id);
        $session->put(SessionKeys::REMEMBER, false);
        $session->forget([SessionKeys::MFA_VERIFIED_AT, SessionKeys::STEP_UP_AT, SessionKeys::TOTP_PENDING]);
        $session->regenerateToken();
        $this->audit->record('impersonation.accept', $target, null, 'success', null, null, $target);

        return response()->json(['data' => $this->present->me($target, $request)]);
    }

    /** Portal: kết thúc giả danh (đăng xuất phiên giả danh). */
    public function end(Request $request): Response
    {
        $impId = $request->session()->get(SessionKeys::IMPERSONATION_ID);
        if (! is_int($impId)) {
            throw ApiProblem::conflict('Phiên hiện tại không phải phiên giả danh.');
        }
        ImpersonationSession::query()->whereKey($impId)->whereNull('ended_at')->update(['ended_at' => Carbon::now()]);
        $this->audit->record('impersonation.end', $request->user() instanceof User ? $request->user() : null);
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->noContent();
    }

    private static function ticketKey(string $ticket): string
    {
        return 'itso:imp-ticket:'.hash('sha256', $ticket);
    }
}
