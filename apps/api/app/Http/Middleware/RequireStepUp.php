<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Auth\ApiTokenAuth;
use App\Auth\MfaService;
use App\Auth\SessionKeys;
use App\Exceptions\ApiProblem;
use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Symfony\Component\HttpFoundation\Response;

/**
 * `itso.step-up`: thao tác nhạy cảm cần xác thực lại MFA trong `itso.auth.step_up_seconds` gần nhất.
 * User chưa bật MFA → mfa_required (phải bật trước). Token API không được làm thao tác nhạy cảm.
 */
final class RequireStepUp
{
    public function __construct(private readonly MfaService $mfa) {}

    public function handle(Request $request, Closure $next): Response
    {
        if ($request->attributes->has(ApiTokenAuth::ATTRIBUTE)) {
            throw ApiProblem::forbidden('Thao tác nhạy cảm không dùng được bằng API token.');
        }
        $user = $request->user();
        if (! $user instanceof User) {
            throw ApiProblem::unauthenticated();
        }
        if (! $this->mfa->enabled($user)) {
            throw ApiProblem::mfaRequired('Thao tác nhạy cảm cần bật MFA.');
        }
        $at = $request->session()->get(SessionKeys::STEP_UP_AT);
        $ttl = (int) config('itso.auth.step_up_seconds', 600);
        if (! is_string($at) || Carbon::parse($at)->addSeconds($ttl)->isPast()) {
            throw ApiProblem::stepUpRequired();
        }

        return $next($request);
    }
}
