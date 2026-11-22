<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Internal;

use App\Domain\Servers\NodeEnrollment;
use App\Exceptions\ApiProblem;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Validation\ValidationException;

/**
 * POST /api/v1/internal/nodes:enroll (ADR 0035/0036). Chỉ itso-relay gọi (qua 127.0.0.1, Caddy chặn đường công khai):
 * chữ ký relay → giới hạn lần sai theo IP node → token một lần + CSR → chứng chỉ + khóa HMAC riêng (trả một lần).
 */
final class NodeEnrollController
{
    public const MAX_FAILURES = 10;

    public const WINDOW_SEC = 600;

    public function __construct(private readonly NodeEnrollment $enrollment) {}

    public function enroll(Request $request): JsonResponse
    {
        NodeEnrollment::verifyRelay($request);
        $ip = (string) $request->header('X-Itso-Relay-Client-Ip', '');
        $ip = filter_var($ip, FILTER_VALIDATE_IP) !== false ? $ip : 'unknown';
        $key = 'node-enroll:'.$ip;
        if (RateLimiter::tooManyAttempts($key, self::MAX_FAILURES)) {
            throw new ApiProblem(429, 'rate_limited', 'Quá nhiều lần join sai', 'Thử lại sau '.RateLimiter::availableIn($key).' giây.');
        }
        try {
            $in = $request->validate([
                'token' => ['required', 'string', 'regex:/^itso_enr_[A-Za-z0-9_-]{32,64}$/'],
                'csr' => ['required', 'string', 'max:8192', 'regex:/^-----BEGIN CERTIFICATE REQUEST-----\n[A-Za-z0-9+\/=\n]+-----END CERTIFICATE REQUEST-----\n?$/'],
                'hostname' => ['required', 'string', 'min:1', 'max:253', 'regex:/^[A-Za-z0-9.-]+$/'],
                'ip_addresses' => ['sometimes', 'array', 'max:16'],
                'ip_addresses.*' => ['string', 'ip'],
                'facts' => ['sometimes', 'array'],
                'facts.os' => ['sometimes', 'nullable', 'string', 'max:200'],
                'facts.kernel' => ['sometimes', 'nullable', 'string', 'max:200'],
                'facts.arch' => ['sometimes', 'string', 'in:amd64,arm64'],
                'facts.agent_version' => ['sometimes', 'string', 'max:50'],
            ]);
            /** @var array{token: string, csr: string, hostname: string, ip_addresses?: list<string>, facts?: array<string, mixed>} $in */
            $out = $this->enrollment->enroll($in, $ip, NodeEnrollment::relayUrl($request));
        } catch (ValidationException $e) {
            RateLimiter::hit($key, self::WINDOW_SEC);
            throw $e;
        } catch (ApiProblem $e) {
            if ($e->status === 422) {
                RateLimiter::hit($key, self::WINDOW_SEC);
            }
            throw $e;
        }
        RateLimiter::clear($key);

        return response()->json(['data' => $out], 201);
    }
}
