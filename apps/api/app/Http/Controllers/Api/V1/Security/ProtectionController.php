<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Security;

use App\Domain\Security\MalwareService;
use App\Domain\Security\WafService;
use App\Http\Support\Listing;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\MalwareFinding;
use App\Models\MalwareScan;
use App\Models\QuarantineItem;
use App\Models\WafEvent;
use App\Models\Website;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Mã độc (tag Malware/Protection) và WAF (tag WAF) cho Admin (theo phạm vi) và Portal (account của mình).
 * Phạm vi luôn đi qua Access::accounts nên USER không thấy account khác (404).
 */
final class ProtectionController extends SecurityBase
{
    public function findings(Request $request): JsonResponse
    {
        $q = MalwareFinding::query()->with(['scan.account', 'scan.website'])
            ->whereIn('scan_id', MalwareScan::query()->select('id')->whereIn('hosting_account_id', $this->accountIds($request)));
        Listing::search($request, $q, ['malware_findings.path', 'malware_findings.signature']);

        return response()->json(Listing::page($request, $q, ['found_at' => 'malware_findings.found_at', 'path' => 'malware_findings.path'],
            '-found_at', fn (MalwareFinding $f): array => MalwareService::presentFinding($f)));
    }

    public function scans(Request $request): JsonResponse
    {
        $q = MalwareScan::query()->with(['account', 'website'])->whereIn('hosting_account_id', $this->accountIds($request));

        return response()->json(Listing::page($request, $q, ['started_at' => 'malware_scans.started_at', 'id' => 'malware_scans.id'],
            '-id', fn (MalwareScan $s): array => self::scan($s)));
    }

    public function quarantineList(Request $request): JsonResponse
    {
        $q = QuarantineItem::query()->with('account')->whereIn('hosting_account_id', $this->accountIds($request));
        Listing::search($request, $q, ['quarantine_items.original_path', 'quarantine_items.signature']);

        return response()->json(Listing::page($request, $q, ['quarantined_at' => 'quarantine_items.quarantined_at'],
            '-quarantined_at', fn (QuarantineItem $i): array => MalwareService::presentQuarantine($i)));
    }

    public function quarantine(Request $request, string $id, MalwareService $m): JsonResponse
    {
        return $this->accepted($request, $m->quarantine($this->finding($request, $id), $this->actor($request)));
    }

    public function deleteFinding(Request $request, string $id, MalwareService $m): JsonResponse
    {
        return $this->accepted($request, $m->delete($this->finding($request, $id), $this->actor($request)));
    }

    public function restore(Request $request, string $id, MalwareService $m): JsonResponse
    {
        $item = Str::isUuid($id) ? QuarantineItem::query()->where('uuid', $id)->whereIn('hosting_account_id', $this->accountIds($request))->first() : null;
        if (! $item instanceof QuarantineItem) {
            throw new NotFoundHttpException;
        }

        return $this->accepted($request, $m->restore($item, $this->actor($request)));
    }

    public function scanWebsite(Request $request, string $id, MalwareService $m): JsonResponse
    {
        $w = $this->website($request, $id);

        return $this->accepted($request, $m->scan($w->account, $w, $this->actor($request)));
    }

    public function scanAccount(Request $request, string $id, MalwareService $m): JsonResponse
    {
        return $this->accepted($request, $m->scan($this->pathAccount($request, $id), null, $this->actor($request)));
    }

    /** GET /portal/protection: WAF + mã độc theo từng account của USER. */
    public function portal(Request $request, WafService $waf): JsonResponse
    {
        $out = [];
        $accounts = $this->access->accounts($this->actor($request))->orderBy('hosting_accounts.id')->get();
        foreach ($accounts as $a) {
            $sites = Website::query()->where('hosting_account_id', $a->id)->orderBy('id')->get();
            $scanIds = MalwareScan::query()->where('hosting_account_id', $a->id)->select('id');
            $last = MalwareScan::query()->where('hosting_account_id', $a->id)->orderByDesc('id')->first();
            $out[] = ['hosting_account' => ['uuid' => $a->uuid, 'username' => $a->username],
                'websites' => $sites->map(function (Website $w) use ($waf): array {
                    $p = $waf->present($w);

                    return ['website' => $p['website'], 'waf_enabled' => $p['enabled'], 'waf_mode' => $p['mode'], 'blocked_24h' => $p['blocked_24h']];
                })->all(),
                'findings_open' => MalwareFinding::query()->whereIn('scan_id', $scanIds)->where('action', 'none')->count(),
                'last_scan_at' => $last === null ? null : ($last->finished_at ?? $last->started_at)?->toIso8601String(),
                'scan_running' => $last !== null && in_array($last->status, MalwareService::ACTIVE, true)];
        }

        return response()->json(['data' => ['accounts' => $out]]);
    }

    public function waf(Request $request, string $id, WafService $waf): JsonResponse
    {
        $w = $this->website($request, $id);
        $data = $waf->present($w);

        return response()->json(['data' => $data])->header('ETag', self::wafEtag($data));
    }

    public function updateWaf(Request $request, string $id, WafService $waf): JsonResponse
    {
        $w = $this->website($request, $id);
        $in = $request->validate([
            'enabled' => ['sometimes', 'boolean'],
            'mode' => ['sometimes', 'in:detect,block'],
            'paranoia_level' => ['sometimes', 'integer', 'between:1,4'],
            'rule_exclusions' => ['sometimes', 'array', 'max:100'],
            'rule_exclusions.*' => ['string', 'regex:/^[0-9]{6}$/'],
        ]);
        self::only($request, ['enabled', 'mode', 'paranoia_level', 'rule_exclusions']);
        $this->ifMatch($request, self::wafEtag($waf->present($w)));

        return $this->accepted($request, $waf->update($w, $this->actor($request), $in));
    }

    public function wafEvents(Request $request, string $id): JsonResponse
    {
        $w = $this->website($request, $id);
        $q = WafEvent::query()->where('website_id', $w->id);
        Listing::search($request, $q, ['waf_events.uri', 'waf_events.message']);

        return response()->json(Listing::page($request, $q, ['at' => 'waf_events.at'], '-at',
            fn (WafEvent $e): array => WafService::presentEvent($e, $w)));
    }

    /** @return Builder<HostingAccount> */
    private function accountIds(Request $request): Builder
    {
        $q = $this->access->accounts($this->actor($request))->select('hosting_accounts.id');
        $acc = $request->input('filter.hosting_account');
        if (is_string($acc) && Str::isUuid($acc)) {
            $q->where('hosting_accounts.uuid', $acc);
        }

        return $q;
    }

    private function finding(Request $request, string $id): MalwareFinding
    {
        $f = Str::isUuid($id) ? MalwareFinding::query()->where('uuid', $id)
            ->whereIn('scan_id', MalwareScan::query()->select('id')->whereIn('hosting_account_id', $this->accountIds($request)))->first() : null;
        if (! $f instanceof MalwareFinding) {
            throw new NotFoundHttpException;
        }

        return $f;
    }

    /** @return array<string, mixed> */
    private static function scan(MalwareScan $s): array
    {
        $p = MalwareService::presentScan($s);
        if (in_array($s->status, MalwareService::ACTIVE, true) && $s->job_id !== null) {
            $p['state'] = (string) (Job::query()->whereKey($s->job_id)->value('state') ?? $s->status);
        }

        return $p;
    }

    /** @param  array<string, mixed>  $d */
    private static function wafEtag(array $d): string
    {
        return '"'.sha1(json_encode([$d['enabled'], $d['mode'], $d['paranoia_level'], $d['rule_exclusions']], JSON_THROW_ON_ERROR)).'"';
    }
}
