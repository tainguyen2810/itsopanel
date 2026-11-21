<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Security;

use App\Domain\Security\FirewallService;
use App\Http\Support\Listing;
use App\Models\FirewallRule;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/** /admin/servers/{id}/firewall… (tag Firewall, D-76). Chỉ SUPER_ADMIN (quyền security.server). */
final class FirewallController extends SecurityBase
{
    public function rules(Request $request, string $id): JsonResponse
    {
        $s = $this->server($request, $id);
        $q = FirewallRule::query()->where('server_id', $s->id);
        Listing::search($request, $q, ['firewall_rules.comment', 'firewall_rules.port_range']);

        return response()->json(Listing::page($request, $q, ['priority' => 'firewall_rules.priority',
            'created_at' => 'firewall_rules.created_at'], 'priority', fn (FirewallRule $r): array => self::present($r)));
    }

    public function store(Request $request, string $id, FirewallService $fw): JsonResponse
    {
        $s = $this->server($request, $id);
        $in = $request->validate([
            'priority' => ['required', 'integer', 'between:1,9999'],
            'action' => ['required', 'in:accept,drop,reject'],
            'direction' => ['required', 'in:in,out'],
            'protocol' => ['required', 'in:tcp,udp,icmp,any'],
            'ports' => ['sometimes', 'nullable', 'string', 'max:300', 'regex:/^([0-9]{1,5}(-[0-9]{1,5})?)(,[0-9]{1,5}(-[0-9]{1,5})?)*$/'],
            'source' => ['required', 'string', 'max:64'],
            'comment' => ['sometimes', 'string', 'max:200'],
            'enabled' => ['sometimes', 'boolean'],
        ]);
        self::only($request, ['priority', 'action', 'direction', 'protocol', 'ports', 'source', 'comment', 'enabled']);
        $rule = $fw->create($s, $this->actor($request), $this->clientIp($request), $in);

        return response()->json(['data' => self::present($rule->refresh())], 201);
    }

    public function destroy(Request $request, string $id, string $rule, FirewallService $fw): Response
    {
        $s = $this->server($request, $id);
        $r = Str::isUuid($rule) ? FirewallRule::query()->where('server_id', $s->id)->where('uuid', $rule)->first() : null;
        if (! $r instanceof FirewallRule) {
            throw new NotFoundHttpException;
        }
        $fw->delete($s, $this->actor($request), $r);

        return response()->noContent();
    }

    public function preview(Request $request, string $id, FirewallService $fw): JsonResponse
    {
        return response()->json(['data' => $fw->preview($this->server($request, $id), $this->clientIp($request))]);
    }

    public function status(Request $request, string $id, FirewallService $fw): JsonResponse
    {
        return response()->json(['data' => $fw->status($this->server($request, $id))]);
    }

    public function apply(Request $request, string $id, FirewallService $fw): JsonResponse
    {
        $s = $this->server($request, $id);
        $in = $request->validate(['rollback_after_sec' => ['required', 'integer', 'between:30,600']]);

        return $this->accepted($request, $fw->apply($s, $this->actor($request), $this->clientIp($request), (int) $in['rollback_after_sec']));
    }

    public function confirm(Request $request, string $id, FirewallService $fw): JsonResponse
    {
        return $this->accepted($request, $fw->confirm($this->server($request, $id), $this->actor($request)));
    }

    /** @return array<string, mixed> FirewallRule */
    public static function present(FirewallRule $r): array
    {
        return ['uuid' => $r->uuid, 'priority' => $r->priority, 'action' => $r->action, 'direction' => $r->direction,
            'protocol' => $r->protocol, 'ports' => $r->port_range, 'source' => (string) ($r->source_cidr ?? '0.0.0.0/0'),
            'comment' => (string) ($r->comment ?? ''), 'enabled' => $r->enabled, 'created_at' => $r->created_at->toIso8601String(),
            'updated_at' => $r->updated_at->toIso8601String()];
    }
}
