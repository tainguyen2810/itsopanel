<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Domain\Audit\AuditLogger;
use App\Domain\Monitoring\AlertEngine;
use App\Domain\Monitoring\AlertMetrics;
use App\Domain\Monitoring\DefaultAlertRules;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\MonitoringPresenter;
use App\Http\Support\Listing;
use App\Http\Support\OffsetPage;
use App\Models\Alert;
use App\Models\AlertRule;
use App\Models\UptimeCheck;
use App\Models\User;
use App\Models\Website;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Rule cảnh báo (SUPER_ADMIN: monitoring.manage), cảnh báo (ack/silence: monitoring.write) và uptime check
 * (monitoring.write) — D-102, D-105. ADMIN chỉ thấy cảnh báo/website của server hoặc account trong phạm vi.
 */
final class MonitoringController
{
    public const UPTIME_PATH = "/^\\/[A-Za-z0-9._~!$&'()*+,;=:@%\\/?-]*$/";

    public const UPTIME_PATH_BAD = '/(^|\/)\.{1,2}(\/|\?|$)|%2[eEfF]|\/\/|%0[aAdD]/';

    public function __construct(
        private readonly Access $access,
        private readonly MonitoringPresenter $present,
        private readonly AuditLogger $audit,
        private readonly AlertMetrics $metrics,
        private readonly DefaultAlertRules $defaults,
    ) {}

    // ---------------------------------------------------------------- rule

    public function rules(Request $request): JsonResponse
    {
        $this->defaults->ensure();
        $q = AlertRule::query();
        Listing::search($request, $q, ['alert_rules.name', 'alert_rules.metric']);

        return response()->json(Listing::page($request, $q, ['name' => 'alert_rules.name', 'created_at' => 'alert_rules.created_at',
            'severity' => 'alert_rules.severity', 'id' => 'alert_rules.id'], 'name', fn (AlertRule $r): array => $this->present->rule($r)));
    }

    public function rule(Request $request, string $id): JsonResponse
    {
        $r = $this->findRule($id);

        return response()->json(['data' => $this->present->rule($r)])->header('ETag', MonitoringPresenter::ruleEtag($r));
    }

    public function createRule(Request $request): JsonResponse
    {
        $in = $this->ruleInput($request, null);
        if (AlertRule::query()->where('name', $in['name'])->exists()) {
            throw ApiProblem::conflict('Đã có rule cùng tên.');
        }
        $r = new AlertRule(['is_default' => false]);
        $this->fillRule($r, $in);
        $r->save();
        $this->audit->record('alert_rule.create', $r, ['name' => $r->name, 'metric' => $r->metric, 'threshold' => $r->threshold]);

        return response()->json(['data' => $this->present->rule($r->refresh())], 201)->header('ETag', MonitoringPresenter::ruleEtag($r));
    }

    public function updateRule(Request $request, string $id): JsonResponse
    {
        $r = $this->findRule($id);
        $m = $request->header('If-Match');
        if (is_string($m) && $m !== '' && $m !== MonitoringPresenter::ruleEtag($r)) {
            throw new ApiProblem(412, 'precondition_failed', 'Rule đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        $in = $this->ruleInput($request, $r);
        if ($r->is_default) {
            foreach (['metric', 'scope_type', 'scope_id'] as $k) {
                if (array_key_exists($k, $in) && $in[$k] !== $r->getAttribute($k)) {
                    throw ApiProblem::conflict('Rule mặc định chỉ sửa được ngưỡng, thời gian, mức, kênh, nhắc lại và bật/tắt.');
                }
            }
        }
        if (isset($in['name']) && AlertRule::query()->where('name', $in['name'])->whereKeyNot($r->id)->exists()) {
            throw ApiProblem::conflict('Đã có rule cùng tên.');
        }
        $before = $r->only(['name', 'threshold', 'duration_sec', 'severity', 'enabled', 'repeat_sec']);
        $this->fillRule($r, $in);
        $r->save();
        $changes = [];
        foreach ($before as $k => $v) {
            if ($r->getAttribute($k) !== $v) {
                $changes[$k] = [$v, $r->getAttribute($k)];
            }
        }
        $this->audit->record('alert_rule.update', $r, $changes);

        return response()->json(['data' => $this->present->rule($r->refresh())])->header('ETag', MonitoringPresenter::ruleEtag($r));
    }

    public function deleteRule(Request $request, string $id): Response
    {
        $r = $this->findRule($id);
        if ($r->is_default) {
            throw ApiProblem::conflict('Rule mặc định không xóa được; có thể tắt hoặc đổi ngưỡng.');
        }
        if (Alert::query()->where('rule_id', $r->id)->where('state', '<>', 'resolved')->exists()) {
            throw ApiProblem::conflict('Rule đang có cảnh báo chưa kết thúc; tắt rule hoặc chờ cảnh báo resolved.');
        }
        DB::transaction(function () use ($r): void {
            Alert::query()->where('rule_id', $r->id)->delete(); // lịch sử đã resolved của rule
            $r->delete();
        });
        $this->audit->record('alert_rule.delete', $r, ['name' => $r->name]);

        return response()->noContent();
    }

    /** Rule này khớp bao nhiêu đối tượng với số liệu hiện tại (không tạo cảnh báo). */
    public function preview(Request $request): JsonResponse
    {
        $in = $this->ruleInput($request, null);
        $r = new AlertRule(['is_default' => false]);
        $this->fillRule($r, $in);
        $now = Carbon::now();
        $rows = [];
        foreach ($this->metrics->targets($r, $now) as $t) {
            if ($t['value'] !== null && AlertEngine::compare($t['value'], $r->operator, $r->threshold)) {
                $rows[] = ['resource' => ['type' => $t['type'], 'uuid' => $t['uuid']], 'label' => $t['label'], 'value' => $t['value']];
            }
        }

        return response()->json(['data' => ['matches' => count($rows), 'evaluated_at' => $now->toIso8601String(),
            'resources' => array_slice($rows, 0, 20)]]);
    }

    // ---------------------------------------------------------------- cảnh báo

    public function alerts(Request $request): JsonResponse
    {
        $q = $this->scopedAlerts($this->actor($request))->with(['rule', 'server', 'ackedBy']);
        foreach (['state' => ['pending', 'firing', 'resolved'], 'severity' => ['low', 'medium', 'high', 'critical']] as $f => $allowed) {
            $v = $request->query('filter')[$f] ?? null;
            if ($v !== null) {
                if (! in_array($v, $allowed, true)) {
                    throw ApiProblem::field("filter[$f]", 'Giá trị lọc không hợp lệ.');
                }
                $q->where("alerts.$f", $v);
            }
        }
        $server = $request->query('filter')['server'] ?? null;
        if ($server !== null) {
            if (! is_string($server) || ! Str::isUuid($server)) {
                throw ApiProblem::field('filter[server]', 'Server không hợp lệ.');
            }
            $q->whereIn('alerts.server_id', DB::table('servers')->where('uuid', $server)->select('id'));
        }
        Listing::search($request, $q, ['alerts.message']);

        return response()->json(Listing::page($request, $q, ['started_at' => 'alerts.started_at', 'severity' => 'alerts.severity',
            'state' => 'alerts.state', 'id' => 'alerts.id'], '-started_at', fn (Alert $a): array => $this->present->alert($a)));
    }

    public function ack(Request $request, string $id): JsonResponse
    {
        $a = $this->findAlert($request, $id);
        if ($a->state !== 'firing') {
            throw ApiProblem::conflict('Chỉ xác nhận được cảnh báo đang firing.');
        }
        if ($a->acked_at !== null) {
            throw ApiProblem::conflict('Cảnh báo đã được xác nhận.');
        }
        $a->forceFill(['acked_by_user_id' => $this->actor($request)->id, 'acked_at' => Carbon::now()])->save();
        $this->audit->record('alert.ack', $a, ['rule' => $a->rule->name], serverId: $a->server_id);

        return response()->json(['data' => $this->present->alert($a->refresh())]);
    }

    public function silence(Request $request, string $id): JsonResponse
    {
        $a = $this->findAlert($request, $id);
        $in = $request->validate(['duration_sec' => ['required', 'integer', 'min:300', 'max:604800'],
            'reason' => ['sometimes', 'nullable', 'string', 'max:200']]);
        if ($a->state === 'resolved') {
            throw ApiProblem::conflict('Cảnh báo đã kết thúc.');
        }
        $until = Carbon::now()->addSeconds((int) $in['duration_sec']);
        $a->forceFill(['silenced_until' => $until, 'silence_reason' => $in['reason'] ?? null])->save();
        $this->audit->record('alert.silence', $a, ['until' => $until->toIso8601String(), 'reason' => $in['reason'] ?? null],
            serverId: $a->server_id);

        return response()->json(['data' => $this->present->alert($a->refresh())]);
    }

    public function unsilence(Request $request, string $id): JsonResponse
    {
        $a = $this->findAlert($request, $id);
        if (! $a->silenced()) {
            throw ApiProblem::conflict('Cảnh báo không bị tắt tạm.');
        }
        $a->forceFill(['silenced_until' => null, 'silence_reason' => null])->save();
        $this->audit->record('alert.unsilence', $a, null, serverId: $a->server_id);

        return response()->json(['data' => $this->present->alert($a->refresh())]);
    }

    // ---------------------------------------------------------------- uptime

    public function uptimeChecks(Request $request): JsonResponse
    {
        $q = UptimeCheck::query()->with('website')
            ->whereIn('website_id', $this->scopedWebsites($this->actor($request))->select('websites.id'));
        if (is_string($request->query('q')) && trim((string) $request->query('q')) !== '') {
            $q->whereHas('website', fn ($w) => Listing::search($request, $w, ['websites.primary_domain']));
        }

        return response()->json(Listing::page($request, $q, ['created_at' => 'uptime_checks.created_at', 'state' => 'uptime_checks.state',
            'id' => 'uptime_checks.id'], '-created_at', fn (UptimeCheck $c): array => $this->present->uptime($c)));
    }

    public function createUptime(Request $request): JsonResponse
    {
        HostingPackageController::rejectUnknown($request, ['website_uuid', 'path', 'interval_sec', 'keyword', 'enabled']);
        $in = $request->validate(['website_uuid' => ['required', 'uuid']] + self::uptimeRules());
        $w = $this->scopedWebsites($this->actor($request))->where('websites.uuid', $in['website_uuid'])->first();
        if (! $w instanceof Website) {
            throw ApiProblem::field('website_uuid', 'Chọn website trong phạm vi.');
        }
        if (UptimeCheck::query()->where('website_id', $w->id)->exists()) {
            throw ApiProblem::conflict('Website này đã có uptime check.');
        }
        $c = UptimeCheck::query()->create(['website_id' => $w->id, 'path' => $in['path'] ?? '/', 'interval_sec' => $in['interval_sec'] ?? 60,
            'keyword' => $in['keyword'] ?? null, 'enabled' => $in['enabled'] ?? true]);
        $this->audit->record('uptime_check.create', $w, ['path' => $c->path], serverId: $w->server_id);

        return response()->json(['data' => $this->present->uptime($c->refresh())], 201)->header('ETag', MonitoringPresenter::uptimeEtag($c));
    }

    public function updateUptime(Request $request, string $id): JsonResponse
    {
        $c = $this->findUptime($request, $id);

        return self::applyUptime($request, $c, $this->present, $this->audit);
    }

    public function deleteUptime(Request $request, string $id): Response
    {
        $c = $this->findUptime($request, $id);
        $c->delete();
        $this->audit->record('uptime_check.delete', $c->website, null, serverId: $c->website->server_id);

        return response()->noContent();
    }

    public function uptimeResults(Request $request, string $id): JsonResponse
    {
        return self::results($request, $this->findUptime($request, $id));
    }

    // ---------------------------------------------------------------- dùng chung với Portal

    /** @return array<string, list<mixed>> */
    public static function uptimeRules(): array
    {
        return ['path' => ['sometimes', 'string', 'max:200', 'regex:'.self::UPTIME_PATH, 'not_regex:'.self::UPTIME_PATH_BAD],
            'interval_sec' => ['sometimes', 'integer', 'min:60', 'max:3600'],
            'keyword' => ['sometimes', 'nullable', 'string', 'min:1', 'max:100', 'regex:/^[^\x00-\x1f\x7f]+$/u'],
            'enabled' => ['sometimes', 'boolean']];
    }

    public static function applyUptime(Request $request, UptimeCheck $c, MonitoringPresenter $present, AuditLogger $audit): JsonResponse
    {
        $m = $request->header('If-Match');
        if (is_string($m) && $m !== '' && $m !== MonitoringPresenter::uptimeEtag($c)) {
            throw new ApiProblem(412, 'precondition_failed', 'Uptime check đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        HostingPackageController::rejectUnknown($request, ['path', 'interval_sec', 'keyword', 'enabled']);
        $in = $request->validate(self::uptimeRules());
        $changes = [];
        foreach ($in as $k => $v) {
            if ($c->getAttribute($k) !== $v) {
                $changes[$k] = [$c->getAttribute($k), $v];
            }
        }
        $c->fill($in);
        if (array_key_exists('path', $in) || array_key_exists('keyword', $in) || ($in['enabled'] ?? null) === true) {
            // Đổi đích kiểm hoặc bật lại: trạng thái cũ không còn đúng.
            $c->forceFill(['state' => 'unknown', 'consecutive_failures' => 0, 'down_since' => null]);
        }
        $c->save();
        $audit->record('uptime_check.update', $c->website, $changes, serverId: $c->website->server_id);

        return response()->json(['data' => $present->uptime($c->refresh())])->header('ETag', MonitoringPresenter::uptimeEtag($c));
    }

    public static function results(Request $request, UptimeCheck $c): JsonResponse
    {
        $q = DB::table('uptime_results')->where('check_id', $c->id)->orderByDesc('at');

        return response()->json(OffsetPage::of($request, $q, fn (\stdClass $r): array => MonitoringPresenter::result($r)));
    }

    // ---------------------------------------------------------------- nội bộ

    /**
     * @param  array<string, mixed>  $in
     */
    private function fillRule(AlertRule $r, array $in): void
    {
        foreach (['name', 'metric', 'scope_type', 'scope_id', 'operator', 'threshold', 'duration_sec', 'severity', 'enabled', 'repeat_sec'] as $k) {
            if (array_key_exists($k, $in)) {
                $r->setAttribute($k, $in[$k]);
            }
        }
        if (isset($in['channels'])) {
            $r->channels = $in['channels'];
        }
        if (! $r->exists) {
            $r->channels = $in['channels'] ?? ['in_app'];
            $r->channel_ids = [];
            $r->duration_sec = (int) ($in['duration_sec'] ?? 0);
            $r->repeat_sec = (int) ($in['repeat_sec'] ?? 14400);
            $r->enabled = (bool) ($in['enabled'] ?? true);
        }
    }

    /**
     * Kiểm AlertRuleInput (tạo: đủ trường bắt buộc; sửa: một phần). Trả giá trị chuẩn hóa theo cột DB.
     *
     * @return array<string, mixed>
     */
    private function ruleInput(Request $request, ?AlertRule $current): array
    {
        $fields = ['name', 'metric', 'scope_type', 'scope_uuid', 'operator', 'threshold', 'for_sec', 'severity', 'channels', 'enabled', 'repeat_sec'];
        HostingPackageController::rejectUnknown($request, $fields);
        $req = $current === null ? 'required' : 'sometimes';
        $in = $request->validate([
            'name' => [$req, 'string', 'min:1', 'max:120'],
            'metric' => [$req, 'string', 'in:'.implode(',', array_keys(AlertMetrics::CATALOG))],
            'scope_type' => [$req, 'string', 'in:server,hosting_account,website'],
            'scope_uuid' => ['sometimes', 'nullable', 'uuid'],
            'operator' => [$req, 'string', 'in:gt,gte,lt,lte'],
            'threshold' => [$req, 'numeric', 'between:-1000000000,1000000000'],
            'for_sec' => ['sometimes', 'integer', 'min:0', 'max:86400'],
            'severity' => [$req, 'string', 'in:low,medium,high,critical'],
            'channels' => ['sometimes', 'array', 'min:1', 'max:4'],
            'channels.*' => ['string', 'distinct', 'in:in_app,email,telegram,webhook'],
            'enabled' => ['sometimes', 'boolean'],
            'repeat_sec' => ['sometimes', 'integer', 'min:0', 'max:604800'],
        ]);
        $metric = (string) ($in['metric'] ?? $current?->metric);
        $scope = (string) ($in['scope_type'] ?? $current?->scope_type);
        if (! AlertMetrics::supports($metric, $scope)) {
            throw ApiProblem::field('scope_type', 'Chỉ số này không có cho phạm vi đã chọn.');
        }
        $threshold = isset($in['threshold']) ? (float) $in['threshold'] : $current?->threshold;
        if (AlertMetrics::isPct($metric) && $threshold !== null && ($threshold < 0 || $threshold > 100)) {
            throw ApiProblem::field('threshold', 'Ngưỡng phần trăm từ 0 đến 100.');
        }
        $out = [];
        foreach (['name', 'metric', 'scope_type', 'operator', 'severity', 'enabled', 'repeat_sec'] as $k) {
            if (array_key_exists($k, $in)) {
                $out[$k] = $k === 'name' ? trim((string) $in[$k]) : $in[$k];
            }
        }
        if (array_key_exists('threshold', $in)) {
            $out['threshold'] = (float) $in['threshold'];
        }
        if (array_key_exists('for_sec', $in)) {
            $out['duration_sec'] = (int) $in['for_sec'];
        }
        if (array_key_exists('channels', $in)) {
            $out['channels'] = array_values($in['channels']);
        }
        if (array_key_exists('scope_uuid', $in) || array_key_exists('scope_type', $in)) {
            $uuid = $in['scope_uuid'] ?? null;
            $out['scope_id'] = null;
            if ($uuid !== null) {
                $id = DB::table(MonitoringPresenter::SCOPE_TABLES[$scope])->where('uuid', $uuid)->value('id');
                if ($id === null) {
                    throw ApiProblem::field('scope_uuid', 'Không tìm thấy đối tượng của phạm vi.');
                }
                $out['scope_id'] = (int) $id;
            }
        }
        if ($current !== null && array_key_exists('scope_id', $out) && ! array_key_exists('scope_uuid', $in)) {
            unset($out['scope_id']); // chỉ đổi scope_type mà không gửi scope_uuid: giữ nguyên (đã kiểm hỗ trợ ở trên)
        }

        return $out;
    }

    private function findRule(string $id): AlertRule
    {
        $r = Str::isUuid($id) ? AlertRule::query()->where('uuid', $id)->first() : null;
        if (! $r instanceof AlertRule) {
            throw new NotFoundHttpException;
        }

        return $r;
    }

    /** @return Builder<Alert> */
    private function scopedAlerts(User $u): Builder
    {
        $q = Alert::query();
        if ($this->access->isSuperAdmin($u)) {
            return $q;
        }
        $servers = $this->access->servers($u)->select('servers.id');
        $accounts = $this->access->accounts($u)->select('hosting_accounts.id');

        return $q->where(fn ($w) => $w->whereIn('alerts.server_id', $servers)->orWhereIn('alerts.hosting_account_id', $accounts));
    }

    private function findAlert(Request $request, string $id): Alert
    {
        $a = Str::isUuid($id) ? $this->scopedAlerts($this->actor($request))->where('alerts.uuid', $id)->first() : null;
        if (! $a instanceof Alert) {
            throw new NotFoundHttpException;
        }

        return $a;
    }

    /** @return Builder<Website> */
    private function scopedWebsites(User $u): Builder
    {
        return Website::query()->whereIn('websites.hosting_account_id', $this->access->accounts($u)->select('hosting_accounts.id'))
            ->whereNotIn('websites.status', ['deleting']);
    }

    private function findUptime(Request $request, string $id): UptimeCheck
    {
        $c = Str::isUuid($id) ? UptimeCheck::query()->with('website')->where('uuid', $id)
            ->whereIn('website_id', $this->scopedWebsites($this->actor($request))->select('websites.id'))->first() : null;
        if (! $c instanceof UptimeCheck) {
            throw new NotFoundHttpException;
        }

        return $c;
    }

    private function actor(Request $request): User
    {
        /** @var User */
        return $request->user();
    }
}
