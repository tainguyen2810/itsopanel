<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Shared;

use App\Auth\Access;
use App\Auth\Realm;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\JobPresenter;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Nền chung cho API dữ liệu hosting (Phase 6), dùng cho cả /admin và /portal: phạm vi theo Access::accounts (ADMIN:
 * server/account trong phạm vi; USER: account mình sở hữu); ngoài phạm vi → 404.
 */
abstract class DataController
{
    public function __construct(protected readonly Access $access, protected readonly JobPresenter $jobs) {}

    protected function actor(Request $request): User
    {
        /** @var User */
        return $request->user();
    }

    protected function realm(Request $request): string
    {
        return $this->actor($request)->realm === Realm::PORTAL ? Realm::PORTAL : Realm::ADMIN;
    }

    /**
     * @template T of Model
     *
     * @param  class-string<T>  $model
     * @return Builder<T>
     */
    protected function scoped(Request $request, string $model): Builder
    {
        /** @var Builder<T> $q */
        $q = $model::query()->whereIn((new $model)->getTable().'.hosting_account_id',
            $this->access->accounts($this->actor($request))->select('hosting_accounts.id'));
        $acc = $request->input('filter.hosting_account');
        if ($acc !== null) {
            if (! is_string($acc) || ! Str::isUuid($acc)) {
                throw ApiProblem::field('filter.hosting_account', 'filter[hosting_account] phải là UUID.');
            }
            $q->where((new $model)->getTable().'.hosting_account_id', HostingAccount::query()->where('uuid', $acc)->value('id') ?? 0);
        }

        return $q;
    }

    /**
     * @template T of Model
     *
     * @param  class-string<T>  $model
     * @return T
     */
    protected function find(Request $request, string $model, string $id): Model
    {
        $m = Str::isUuid($id) ? $this->scoped($request, $model)->where((new $model)->getTable().'.uuid', $id)->first() : null;
        if (! $m instanceof $model) {
            throw new NotFoundHttpException;
        }

        return $m;
    }

    protected function account(Request $request, mixed $uuid, string $field = 'hosting_account_uuid'): HostingAccount
    {
        $a = is_string($uuid) && Str::isUuid($uuid)
            ? $this->access->accounts($this->actor($request))->where('hosting_accounts.uuid', $uuid)->first() : null;
        if (! $a instanceof HostingAccount) {
            throw ApiProblem::field($field, 'Không tìm thấy tài khoản hosting trong phạm vi.');
        }

        return $a;
    }

    /** Account theo {id} trên đường dẫn (File Manager): ngoài phạm vi → 404. */
    protected function pathAccount(Request $request, string $id): HostingAccount
    {
        $a = Str::isUuid($id) ? $this->access->accounts($this->actor($request))->where('hosting_accounts.uuid', $id)->first() : null;
        if (! $a instanceof HostingAccount) {
            throw new NotFoundHttpException;
        }

        return $a;
    }

    protected function accepted(Request $request, Job $job, ?string $secret = null): JsonResponse
    {
        $data = $this->jobs->job($job->refresh(), $this->realm($request));
        $body = ['job' => $data, 'resource' => $data['resource']];
        if ($secret !== null) {
            $body['secret'] = $secret;
        }

        return response()->json($body, 202)->header('Cache-Control', 'no-store');
    }

    protected function ifMatch(Request $request, string $etag): void
    {
        $m = $request->header('If-Match');
        if (is_string($m) && $m !== '' && $m !== $etag) {
            throw new ApiProblem(412, 'precondition_failed', 'Tài nguyên đã thay đổi', 'Tải lại rồi sửa lại.');
        }
    }

    /** @param  list<string>  $allowed */
    protected static function only(Request $request, array $allowed): void
    {
        $extra = array_diff(array_keys($request->json()->all()), $allowed);
        if ($extra !== []) {
            throw ApiProblem::field((string) reset($extra), 'Trường không được hỗ trợ.');
        }
    }
}
