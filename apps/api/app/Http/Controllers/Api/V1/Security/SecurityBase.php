<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Security;

use App\Exceptions\ApiProblem;
use App\Http\Controllers\Api\V1\Shared\DataController;
use App\Models\Server;
use App\Models\Website;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/** Khung chung của Security Center (Phase 7): tìm server/website theo phạm vi, IP thật của người dùng. */
abstract class SecurityBase extends DataController
{
    protected function server(Request $request, string $id): Server
    {
        $s = Str::isUuid($id) ? $this->access->servers($this->actor($request))->where('servers.uuid', $id)->first() : null;
        if (! $s instanceof Server) {
            throw new NotFoundHttpException;
        }

        return $s;
    }

    /** Tham số query `server` (bắt buộc, ServerQuery). */
    protected function serverQuery(Request $request): Server
    {
        $id = $request->query('server');
        if (! is_string($id) || ! Str::isUuid($id)) {
            throw ApiProblem::field('server', 'server phải là UUID máy chủ.');
        }

        return $this->server($request, $id);
    }

    /** @return Builder<Server> server trong phạm vi, lọc theo filter[server] nếu có */
    protected function servers(Request $request): Builder
    {
        $q = $this->access->servers($this->actor($request));
        $f = $request->input('filter.server');
        if ($f !== null) {
            if (! is_string($f) || ! Str::isUuid($f)) {
                throw ApiProblem::field('filter.server', 'filter[server] phải là UUID.');
            }
            $q->where('servers.uuid', $f);
        }

        return $q;
    }

    protected function website(Request $request, string $id): Website
    {
        $w = Str::isUuid($id) ? Website::query()->where('uuid', $id)
            ->whereIn('hosting_account_id', $this->access->accounts($this->actor($request))->select('hosting_accounts.id'))->first() : null;
        if (! $w instanceof Website) {
            throw new NotFoundHttpException;
        }

        return $w;
    }

    /** IP của người dùng sau proxy tin cậy (TrustProxies), không bao giờ lấy từ body (ADR 0023). */
    protected function clientIp(Request $request): string
    {
        return (string) $request->ip();
    }
}
