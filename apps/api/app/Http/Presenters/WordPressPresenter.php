<?php

declare(strict_types=1);

namespace App\Http\Presenters;

use App\Domain\WordPress\WordPressService;
use App\Models\BackupSnapshot;
use App\Models\User;
use App\Models\WordPressComponent;
use App\Models\WordPressSite;
use App\Models\WordPressUpdate;

/** WordPressSite, WordPressSiteDetail, WordPressUpdate (contracts/openapi, D-99). */
final class WordPressPresenter
{
    /** @return array<string, mixed> WordPressSite */
    public static function site(WordPressSite $wp): array
    {
        $w = $wp->website;
        $a = $wp->account;
        $comps = WordPressComponent::query()->where('wordpress_site_id', $wp->id)->get();
        $core = $comps->firstWhere('type', 'core');
        $last = WordPressUpdate::query()->where('wordpress_site_id', $wp->id)->orderByDesc('id')->first();
        $hard = [];
        foreach (WordPressService::HARDENING as $k) {
            $hard[$k] = (bool) ($wp->hardening[$k] ?? false);
        }
        $version = (string) ($core->version ?? $wp->version ?? '');

        return ['uuid' => $wp->uuid, 'website' => ['uuid' => $w->uuid, 'primary_domain' => $w->primary_domain],
            'hosting_account' => ['uuid' => $a->uuid, 'username' => $a->username],
            'wp_version' => $version, 'latest_version' => (string) ($core->update_version ?? $version),
            'plugins_total' => $comps->where('type', 'plugin')->count(),
            'plugins_outdated' => $comps->where('type', 'plugin')->whereNotNull('update_version')->count(),
            'themes_outdated' => $comps->where('type', 'theme')->whereNotNull('update_version')->count(),
            'auto_update' => $wp->auto_update, 'update_window' => $wp->update_window, 'hardening' => $hard,
            'maintenance' => $wp->maintenance, 'admin_username' => $wp->admin_user, 'php_version' => $w->php_version,
            'state' => match ($wp->state) {
                'updating' => 'updating', 'cloning' => 'cloning', 'error' => 'error', default => 'ready',
            },
            'last_update' => $last instanceof WordPressUpdate ? ['uuid' => $last->uuid, 'state' => $last->state,
                'at' => ($last->finished_at ?? $last->started_at ?? $last->created_at)->toIso8601String()] : null,
            'staging_of' => $wp->staging_of_id !== null ? WordPressSite::withTrashed()->whereKey($wp->staging_of_id)->value('uuid') : null,
            'updated_at' => $wp->updated_at->toIso8601String()];
    }

    /** @return array<string, mixed> WordPressSiteDetail */
    public static function detail(WordPressSite $wp): array
    {
        $comps = WordPressComponent::query()->where('wordpress_site_id', $wp->id)->orderBy('type')->orderBy('slug')->get();
        $core = $comps->firstWhere('type', 'core');
        $version = (string) ($core->version ?? $wp->version ?? '');
        $staging = WordPressSite::query()->where('staging_of_id', $wp->id)->with('website')->orderBy('id')->get()
            ->filter(fn (WordPressSite $s): bool => ! $s->website->trashed())
            ->map(fn (WordPressSite $s): array => ['uuid' => $s->uuid, 'domain' => $s->website->primary_domain,
                'created_at' => $s->created_at->toIso8601String()])->values()->all();

        return ['site' => self::site($wp),
            'core' => ['version' => $version, 'latest_version' => (string) ($core->update_version ?? $version), 'checksums_ok' => $wp->checksums_ok],
            'components' => $comps->where('type', '!=', 'core')->map(fn (WordPressComponent $c): array => [
                'type' => $c->type, 'slug' => (string) $c->slug, 'name' => $c->name, 'version' => $c->version,
                'latest_version' => $c->update_version, 'active' => $c->active, 'auto_update' => $wp->auto_update !== 'off',
            ])->values()->all(),
            'staging' => $staging];
    }

    /** @return array<string, mixed> WordPressUpdate */
    public static function update(WordPressUpdate $u, string $siteUuid): array
    {
        $snap = $u->snapshot_id !== null ? BackupSnapshot::query()->whereKey($u->snapshot_id)->value('uuid') : null;
        $by = $u->requested_by_user_id !== null ? User::query()->find($u->requested_by_user_id) : null;

        return ['uuid' => $u->uuid, 'site_uuid' => $siteUuid, 'trigger' => $u->trigger, 'state' => $u->state,
            'items' => array_map(fn (array $it): array => ['type' => (string) $it['type'], 'slug' => (string) ($it['slug'] ?? ''),
                'from' => (string) ($it['from_version'] ?? ''), 'to' => (string) ($it['to_version'] ?? '')], $u->items),
            'steps' => array_map(fn (array $s): array => ['key' => (string) $s['key'], 'state' => (string) $s['state']], $u->steps),
            'snapshot_uuid' => is_string($snap) ? $snap : null, 'error' => $u->error,
            'requested_by' => $by instanceof User ? HostingPresenter::userRef($by) : null,
            'started_at' => ($u->started_at ?? $u->created_at)->toIso8601String(), 'finished_at' => $u->finished_at?->toIso8601String()];
    }
}
