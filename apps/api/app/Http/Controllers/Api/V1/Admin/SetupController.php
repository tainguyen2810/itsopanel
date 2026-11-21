<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\MfaService;
use App\Auth\SessionKeys;
use App\Domain\Audit\AuditLogger;
use App\Domain\Setup\SetupWizard;
use App\Domain\Users\UserService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\ServerPresenter;
use App\Http\Presenters\UserPresenter;
use App\Models\Server;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\RateLimiter;

/**
 * /admin/setup/* — wizard cài đặt lần đầu (Prompt 4.5): bước 0 (mã), 1 (ngôn ngữ), 2 (SA + TOTP), 3 (truy cập),
 * 6 (quota), 9 (khóa). Bước 0–2 công khai nhưng cần phiên đã xác minh mã; bước 3+ cần SA do wizard tạo, đã bật TOTP.
 */
final class SetupController
{
    public function __construct(
        private readonly SetupWizard $wizard,
        private readonly MfaService $mfa,
        private readonly UserService $users,
        private readonly UserPresenter $present,
        private readonly AuditLogger $audit,
    ) {}

    public function status(Request $request): JsonResponse
    {
        return $this->statusResponse($request);
    }

    public function verifyCode(Request $request): JsonResponse
    {
        $this->wizard->ensureOpen();
        $key = 'setup-code:'.$request->ip();
        if (RateLimiter::tooManyAttempts($key, 10)) {
            throw ApiProblem::rateLimited(RateLimiter::availableIn($key), 'Nhập sai mã quá nhiều lần, thử lại sau.');
        }
        $in = $request->validate(['code' => ['required', 'string', 'regex:/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/']]);
        try {
            $sha = $this->wizard->verifyCode((string) $in['code']);
        } catch (ApiProblem $e) {
            RateLimiter::hit($key, 600);
            throw $e;
        }
        RateLimiter::clear($key);
        $request->session()->regenerate();
        $request->session()->put(SetupWizard::SESSION_VERIFIED, $sha);
        $this->audit->record('setup.code_verified', null, null, 'success', null, null, null);

        return $this->statusResponse($request);
    }

    public function preferences(Request $request): JsonResponse
    {
        $this->wizard->ensureOpen();
        $this->requireVerified($request);
        $in = $request->validate([
            'locale' => ['required', 'in:vi,en'],
            'timezone' => ['required', 'string', 'max:64', 'timezone:all'],
        ]);
        $this->wizard->put('locale', $in['locale']);
        $this->wizard->put('timezone', $in['timezone']);

        return $this->statusResponse($request);
    }

    public function createAdmin(Request $request): JsonResponse
    {
        $this->wizard->ensureOpen();
        $this->requireVerified($request);
        $in = $request->validate([
            'name' => ['required', 'string', 'min:2', 'max:120'],
            'email' => ['required', 'string', 'email', 'max:190'],
            'password' => ['required', 'string', 'min:12', 'max:200'],
        ]);
        $user = DB::transaction(function () use ($in): User {
            if ($this->wizard->wizardAdmin() !== null) {
                throw ApiProblem::conflict('Wizard đã tạo SUPER_ADMIN; đăng nhập bằng tài khoản đó để tiếp tục.');
            }
            $email = mb_strtolower(trim((string) $in['email']));
            if (User::query()->where('realm', 'admin')->where('email', $email)->exists()) {
                throw ApiProblem::field('email', 'Email đã được dùng.');
            }
            $u = User::query()->create([
                'realm' => 'admin', 'name' => trim((string) $in['name']), 'email' => $email,
                'password_hash' => Hash::make((string) $in['password']), 'locale' => $this->wizard->locale(),
                'timezone' => $this->wizard->timezone(), 'status' => 'active',
            ]);
            $this->users->setRole($u, 'SUPER_ADMIN');
            $this->wizard->put('admin_user_id', $u->id, $u->id);

            return $u;
        });
        Auth::guard('web')->login($user);
        $session = $request->session();
        $session->regenerate();
        $session->put(SessionKeys::CREATED_AT, Carbon::now()->toIso8601String());
        $session->put(SessionKeys::REMEMBER, false);
        $session->forget([SessionKeys::MFA_VERIFIED_AT, SessionKeys::STEP_UP_AT, SessionKeys::TOTP_PENDING]);
        $session->regenerateToken();
        $this->audit->record('setup.admin_created', $user, ['email' => $user->email], 'success', null, null, $user);

        return response()->json(['data' => $this->present->me($user->refresh(), $request)], 201);
    }

    public function access(Request $request): JsonResponse
    {
        $user = $this->requireWizardAdmin($request);
        $in = $request->validate([
            'panel_domain' => ['present', 'nullable', 'string', 'max:253',
                'regex:/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/'],
            'panel_port' => ['required', 'integer', 'min:1024', 'max:65535', 'not_in:3306,5432,5433,6379,8080'],
            'entrance_path' => ['present', 'nullable', 'string', 'regex:/^\/[a-z0-9][a-z0-9-]{3,31}$/'],
            'allowlist' => ['present', 'array', 'max:50'],
            'allowlist.*' => ['string', 'distinct', function (string $attr, mixed $v, \Closure $fail): void {
                if (! is_string($v) || ! self::validCidr($v)) {
                    $fail('Địa chỉ IP/CIDR không hợp lệ.');
                }
            }],
        ]);
        $access = ['panel_domain' => $in['panel_domain'] ?? null, 'panel_port' => (int) $in['panel_port'],
            'entrance_path' => $in['entrance_path'] ?? null, 'allowlist' => array_values(array_map('strval', $in['allowlist']))];
        $this->wizard->put('access', $access, $user->id);
        $this->audit->record('setup.access_saved', null, $access, 'success', null, null, $user);

        return $this->statusResponse($request);
    }

    public function quota(Request $request): JsonResponse
    {
        $user = $this->requireWizardAdmin($request);
        $server = Server::query()->where('name', (string) config('itso.local_server.name'))->first()
            ?? Server::query()->orderBy('id')->first();
        $p = $server !== null ? ServerPresenter::platform($server->observed_facts) : null;
        $this->wizard->put('quota_seen_at', Carbon::now()->toIso8601String(), $user->id);

        return response()->json(['data' => [
            'mode' => $p['quota_mode'] ?? 'unknown',
            'server' => $server !== null ? ['uuid' => $server->uuid, 'name' => $server->name] : null,
            'facts_at' => $p['facts_at'] ?? null,
        ]]);
    }

    public function complete(Request $request): JsonResponse
    {
        $user = $this->requireWizardAdmin($request);
        if (! is_array($this->wizard->get('access'))) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Chưa xong bước truy cập panel',
                'Lưu cấu hình truy cập (bước 3) trước khi hoàn tất.');
        }
        $this->wizard->complete();
        $request->session()->forget(SetupWizard::SESSION_VERIFIED);
        $this->audit->record('setup.completed', null, null, 'success', null, null, $user);

        return response()->json(['data' => $this->wizard->status(false, true)]);
    }

    public static function validCidr(string $v): bool
    {
        [$ip, $bits] = array_pad(explode('/', $v, 2), 2, null);
        $v4 = filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false;
        $v6 = ! $v4 && filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false;
        if (! $v4 && ! $v6) {
            return false;
        }
        if ($bits === null) {
            return true;
        }

        return ctype_digit($bits) && (int) $bits <= ($v4 ? 32 : 128);
    }

    private function requireVerified(Request $request): void
    {
        if (! $this->wizard->sessionVerified($request->session()->get(SetupWizard::SESSION_VERIFIED))) {
            throw new ApiProblem(403, 'setup_not_verified', 'Chưa xác minh mã thiết lập', 'Nhập mã thiết lập ở bước 0 trước.');
        }
    }

    private function requireWizardAdmin(Request $request): User
    {
        $this->wizard->ensureOpen();
        /** @var User $user */
        $user = $request->user();
        $admin = $this->wizard->wizardAdmin();
        if ($admin === null || $admin->id !== $user->id || ! $this->mfa->enabled($user)) {
            throw ApiProblem::forbidden('Chỉ SUPER_ADMIN do wizard tạo, đã bật TOTP, mới làm được bước này.');
        }

        return $user;
    }

    private function statusResponse(Request $request): JsonResponse
    {
        $verified = $this->wizard->sessionVerified($request->session()->get(SetupWizard::SESSION_VERIFIED));
        $admin = $this->wizard->wizardAdmin();

        return response()->json(['data' => $this->wizard->status($verified, $admin !== null && $this->mfa->enabled($admin))]);
    }
}
