<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Portal;

use App\Auth\Access;
use App\Domain\Audit\AuditLogger;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\HostingPresenter;
use App\Http\Presenters\UserPresenter;
use App\Http\Support\Listing;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\Notification;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * API Portal (Prompt 3.5): USER chỉ đọc account mình sở hữu (`owner_user_id`), tài nguyên người khác → 404.
 * Thay đổi account (khóa, đổi gói…) chỉ ở Admin.
 */
final class PortalController
{
    public function __construct(
        private readonly Access $access,
        private readonly HostingPresenter $present,
        private readonly UserPresenter $users,
        private readonly AuditLogger $audit,
    ) {}

    public function accounts(Request $request): JsonResponse
    {
        $request->validate(['filter.lifecycle_state' => ['sometimes', 'in:pending,provisioning,active,suspended,migrating,terminated,purged,failed']]);
        $q = $this->access->accounts($this->user($request))->where('lifecycle_state', '<>', 'purged');
        $state = $request->input('filter.lifecycle_state');
        if (is_string($state)) {
            $q->where('lifecycle_state', $state);
        }
        Listing::search($request, $q, ['hosting_accounts.username']);

        return response()->json(Listing::page($request, $q,
            ['created_at' => 'hosting_accounts.created_at', 'username' => 'hosting_accounts.username'],
            '-created_at', fn (HostingAccount $a): array => $this->present->account($a)));
    }

    public function account(Request $request, string $id): JsonResponse
    {
        $a = $this->find($request, $id);

        return response()->json(['data' => $this->present->account($a)])->header('ETag', HostingPresenter::accountEtag($a));
    }

    public function features(Request $request, string $id): JsonResponse
    {
        return response()->json(['data' => $this->present->features($this->find($request, $id))]);
    }

    public function usage(Request $request, string $id): JsonResponse
    {
        return response()->json(['data' => $this->present->account($this->find($request, $id))['usage']]);
    }

    public function overview(Request $request): JsonResponse
    {
        $u = $this->user($request);
        $accounts = $this->access->accounts($u)->whereNotIn('lifecycle_state', ['purged'])->orderBy('username')->get();
        $rows = [];
        $warnings = [];
        foreach ($accounts as $a) {
            $usage = $this->present->account($a)['usage'];
            $rows[] = ['hosting_account' => ['uuid' => $a->uuid, 'username' => $a->username], 'lifecycle_state' => $a->lifecycle_state,
                'usage' => $usage];
            $disk = $usage['disk_mb'];
            $pct = $disk['limit'] > 0 ? (int) floor($disk['used'] * 100 / $disk['limit']) : 0;
            if ($pct >= 70) {
                $warnings[] = ['code' => $pct >= 90 ? 'disk_90' : 'disk_70', 'severity' => $pct >= 90 ? 'high' : 'medium',
                    'message' => "{$a->username}: dung lượng đã dùng $pct%"];
            }
            if ($a->lifecycle_state === 'suspended') {
                $warnings[] = ['code' => 'account_suspended', 'severity' => 'high', 'message' => "{$a->username}: đang bị tạm ngưng"];
            }
            if ($a->lifecycle_state === 'terminated' && $a->purge_after !== null) {
                $warnings[] = ['code' => 'account_terminated', 'severity' => 'critical',
                    'message' => "{$a->username}: đã chấm dứt, dữ liệu giữ tới {$a->purge_after->toDateString()}"];
            }
        }
        $jobs = $this->access->jobs($u)->orderByDesc('created_at')->orderByDesc('id')->limit(5)->get()
            ->map(fn (Job $j): array => ['uuid' => $j->uuid, 'type' => $j->type, 'state' => $j->state, 'progress' => (int) $j->progress])
            ->values()->all();

        return response()->json(['data' => [
            'accounts' => $rows,
            'warnings' => $warnings,
            'recent_jobs' => $jobs,
            'notifications_unread' => Notification::query()->where('user_id', $u->id)->whereNull('read_at')->count(),
        ]]);
    }

    public function profile(Request $request): JsonResponse
    {
        $u = $this->user($request);

        return response()->json(['data' => $this->users->user($u)])->header('ETag', self::etag($u));
    }

    public function updateProfile(Request $request): JsonResponse
    {
        $u = $this->user($request);
        $ifMatch = $request->header('If-Match');
        if (is_string($ifMatch) && $ifMatch !== '' && $ifMatch !== self::etag($u)) {
            throw new ApiProblem(412, 'precondition_failed', 'Hồ sơ đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        $unknown = array_diff(array_keys($request->json()->all()), ['name', 'locale', 'timezone']);
        if ($unknown !== []) {
            throw ApiProblem::field((string) reset($unknown), 'Không sửa được trường này.');
        }
        $in = $request->validate(['name' => ['sometimes', 'string', 'min:1', 'max:120'], 'locale' => ['sometimes', 'in:vi,en'],
            'timezone' => ['sometimes', 'string', 'timezone:all']]);
        $changes = [];
        foreach ($in as $k => $v) {
            $v = is_string($v) ? trim($v) : $v;
            if ($u->getAttribute($k) !== $v) {
                $changes[$k] = ['from' => $u->getAttribute($k), 'to' => $v];
                $u->setAttribute($k, $v);
            }
        }
        if ($changes !== []) {
            $u->save();
            $this->audit->record('profile.update', $u, $changes);
        }

        return response()->json(['data' => $this->users->user($u->refresh())])->header('ETag', self::etag($u));
    }

    private static function etag(User $u): string
    {
        return '"usr-'.sha1(json_encode([$u->name, $u->locale, $u->timezone, $u->updated_at->format('U.u')], JSON_THROW_ON_ERROR)).'"';
    }

    private function find(Request $request, string $id): HostingAccount
    {
        $a = Str::isUuid($id) ? $this->access->accounts($this->user($request))->where('hosting_accounts.uuid', $id)
            ->where('lifecycle_state', '<>', 'purged')->first() : null;
        if (! $a instanceof HostingAccount) {
            throw new NotFoundHttpException;
        }

        return $a;
    }

    private function user(Request $request): User
    {
        /** @var User */
        return $request->user();
    }
}
