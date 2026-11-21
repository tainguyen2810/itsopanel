import type { components as A } from '@/api/generated/admin/schema';
import { minInterval, parseCron } from '@/shared/hosting/cron';
import { contentError, PROXIABLE, type DnsType } from '@/shared/hosting/dns';
import { isInside, isValidName, joinPath, normalizePath, parentPath } from '@/shared/hosting/paths';
import type { DemoDb } from '../db';
import { page } from '../list';
import {
  created,
  noContent,
  ok,
  on as onRoute,
  problem,
  type ApiPath,
  type Ctx,
  type Reply,
} from '../router';
import { canSeeAccount, visibility } from '../scope';
import { actorRef, startJob } from './writes';

type S = A['schemas'];
type Account = S['HostingAccount'];
type Website = S['Website'];
type FileEntry = S['FileEntry'];
type GitRepo = S['GitRepository'];
type GitDeploy = S['GitDeployment'];

const invalid = (detail: string) =>
  problem(422, 'validation_failed', 'Dữ liệu không hợp lệ', detail);
const limit = (detail: string) =>
  problem(422, 'package_limit_reached', 'Vượt giới hạn của gói hosting', detail);
/** Vượt hạn mức tài nguyên đếm theo gói: giống QuotaService (422 quota_exceeded, errors theo tài nguyên). */
const quota = (resource: string, detail: string): Reply => {
  const r = problem(422, 'quota_exceeded', 'Vượt giới hạn gói', detail);
  return { ...r, body: { ...(r.body as object), errors: { [resource]: [detail] } } };
};
const notFound = (what: string) => problem(404, 'not_found', `Không tìm thấy ${what}`);
const isReply = (x: unknown): x is Reply =>
  typeof x === 'object' && x !== null && 'status' in x && !('uuid' in x) && !('path' in x);

const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$/;
const DB_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** pid#tid của worker nginx trong dòng log lỗi. */
const NGX_PID = ['2211', '2211'].join('#');
const SIZE = /^[0-9]{1,5}[kmg]?$/;

/** Đường dẫn API theo realm (Admin và Portal dùng chung handler, lọc theo phạm vi người gọi). */
const at = (realm: string, p: string) => `/api/v1/${realm}${p}` as ApiPath;

function accountById(ctx: Ctx, uuid: string | undefined): Account | Reply {
  const a = ctx.db.data.accounts.find((x) => x.uuid === uuid);
  const v = visibility(ctx.db, ctx.actor);
  if (!a || !canSeeAccount(v, a.uuid))
    return invalid('Chọn tài khoản hosting trong phạm vi của bạn.');
  if (a.lifecycle_state !== 'active') {
    return problem(409, 'invalid_state_transition', 'Tài khoản không ở trạng thái hoạt động');
  }
  return a;
}
const limitsOf = (db: DemoDb, a: Account) =>
  db.data.package_versions.find(
    (v) => v.package_uuid === a.package.uuid && v.version === a.package.version,
  )?.limits ?? db.data.packages.find((p) => p.uuid === a.package.uuid)?.limits;

const accRef = (a: Account) => ({ uuid: a.uuid, username: a.username });
const siteRef = (w: Website) => ({ uuid: w.uuid, primary_domain: w.primary_domain });

/** Bản ghi có trường hosting_account mà người gọi thấy được, theo id trên đường dẫn. */
function owned<T extends { uuid: string; hosting_account: { uuid: string } | null }>(
  ctx: Ctx,
  rows: T[],
  what: string,
  id = ctx.params.id,
): T | Reply {
  const r = rows.find((x) => x.uuid === id);
  const v = visibility(ctx.db, ctx.actor);
  return r && canSeeAccount(v, r.hosting_account?.uuid) ? r : notFound(what);
}
const siteOf = (ctx: Ctx) => owned(ctx, ctx.db.data.websites, 'website');
const accountOfSite = (db: DemoDb, w: Website) =>
  db.data.accounts.find((a) => a.uuid === w.hosting_account.uuid) as Account;

/** Đánh dấu tài nguyên desired/observed: tạo → provisioning, job xong → ready. */
function applied(
  r: { status: string; spec_version: number; observed_version: number; observed_at: string | null },
  db: DemoDb,
) {
  r.status = 'ready';
  r.observed_version = r.spec_version;
  r.observed_at = db.now();
}
function bump(r: { spec_version: number; updated_at: string }, db: DemoDb) {
  r.spec_version += 1;
  r.updated_at = db.now();
}
const fresh = (db: DemoDb) => ({
  status: 'provisioning' as const,
  spec_version: 1,
  observed_version: 0,
  drift: null,
  observed_at: null,
  created_at: db.now(),
  updated_at: db.now(),
});

// ---------------------------------------------------------------- hệ thống file ảo trong home
interface Node {
  entry: FileEntry;
  content?: string;
}
type Fs = Record<string, Node>;

function sampleContent(path: string, a: Account): string {
  if (path.endsWith('.php')) {
    return `<?php\n// ${path}\nrequire __DIR__ . '/../vendor/autoload.php';\n\n$app = require_once __DIR__ . '/../bootstrap/app.php';\n$app->handleRequest(Illuminate\\Http\\Request::capture());\n`;
  }
  if (path.endsWith('.html'))
    return `<!doctype html>\n<html lang="vi">\n<head><meta charset="utf-8"><title>${a.username}</title></head>\n<body><h1>Xin chào từ ${a.username}</h1></body>\n</html>\n`;
  if (path.endsWith('.env'))
    return `APP_ENV=production\nAPP_DEBUG=false\nDB_HOST=localhost\nDB_DATABASE=${a.username}_web\nDB_USERNAME=${a.username}_web\nDB_PASSWORD=********\n`;
  if (path.endsWith('.log'))
    return '203.0.113.50 - - [20/Nov/2026:08:14:02 +0700] "GET / HTTP/2.0" 200 5123\n';
  if (path.endsWith('.bashrc')) return '# ~/.bashrc\nexport PATH="$HOME/bin:$PATH"\n';
  return '';
}

/** Cây thư mục mẫu của account: sites/<domain>/{public,...}, logs, tmp, backups. Sinh khi đọc lần đầu. */
function fsOf(db: DemoDb, a: Account): Fs {
  const key = `fs@${a.uuid}`;
  if (db.data[key]) return db.data[key] as Fs;
  const fs: Fs = {};
  const add = (
    path: string,
    type: FileEntry['type'],
    size = 4096,
    mode?: string,
    when = '2026-11-18T09:30:00+07:00',
  ) => {
    fs[path] = {
      entry: {
        name: path.split('/').at(-1) as string,
        path,
        type,
        size: type === 'dir' ? 4096 : size,
        mode: mode ?? (type === 'dir' ? '0750' : '0640'),
        owner: a.username,
        modified_at: when,
      },
      ...(type === 'file' ? { content: sampleContent(path, a) } : {}),
    };
  };
  for (const d of ['sites', 'logs', 'tmp', 'backups']) add(d, 'dir');
  add('.bashrc', 'file', 220, '0644');
  for (const w of db.data.websites.filter((x) => x.hosting_account.uuid === a.uuid)) {
    const base = `sites/${w.primary_domain}`;
    add(base, 'dir');
    add(`${base}/${w.document_root}`, 'dir');
    if (w.type === 'php') {
      add(`${base}/${w.document_root}/index.php`, 'file', 1734);
      add(`${base}/.env`, 'file', 912, '0600');
      add(`${base}/storage`, 'dir');
    } else {
      add(`${base}/${w.document_root}/index.html`, 'file', 512, '0644');
    }
    add(
      `logs/${w.primary_domain}.access.log`,
      'file',
      182_340,
      '0640',
      '2026-11-20T08:15:00+07:00',
    );
    add(`logs/${w.primary_domain}.error.log`, 'file', 2_310, '0640', '2026-11-20T08:15:00+07:00');
  }
  for (const f of db.data.files) {
    if (f.owner === a.username && !fs[f.path])
      fs[f.path] = {
        entry: structuredClone(f),
        ...(f.type === 'file' ? { content: sampleContent(f.path, a) } : {}),
      };
  }
  db.data[key] = fs;
  return fs;
}

/** Đường dẫn tương đối trong home; chặn `..` thoát ra ngoài hay đường dẫn tuyệt đối khác home (như agent: path_outside_home). */
function relPath(a: Account, raw: string | null | undefined): string | Reply {
  if (raw === null || raw === undefined) return invalid('Thiếu đường dẫn.');
  const p = normalizePath(raw, a.home_path);
  return p === null ? invalid('Đường dẫn nằm ngoài thư mục home của tài khoản.') : p;
}

const children = (fs: Fs, dir: string) =>
  Object.values(fs)
    .filter((n) => parentPath(n.entry.path) === dir && n.entry.path !== '.')
    .map((n) => n.entry)
    .sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === 'dir' ? -1 : 1));

function etag(n: Node) {
  let h = 0;
  for (const ch of n.content ?? '') h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `W/"${(h >>> 0).toString(16)}-${n.content?.length ?? 0}"`;
}

// ---------------------------------------------------------------- DNS: record theo zone
/** Nhà cung cấp DNS của mỗi DemoDb và provider của từng zone (dataset chưa có bảng provider). */
const providerStore = new WeakMap<DemoDb, A['schemas']['DnsProvider'][]>();
const zoneProvider = new Map<string, string>();
function recordsOf(db: DemoDb, zone: S['DnsZone']): S['DnsRecord'][] {
  const key = `dns@${zone.uuid}`;
  if (db.data[key]) return db.data[key] as S['DnsRecord'][];
  const first = db.data.dns_zones[0]?.uuid === zone.uuid;
  const acc = db.data.accounts.find((a) => a.uuid === zone.hosting_account?.uuid);
  const srv = db.data.servers.find((s) => s.uuid === acc?.server.uuid) ?? db.data.servers[0];
  const ip = srv?.ip_addresses.at(-1) ?? '203.0.113.10';
  const rows: S['DnsRecord'][] = first
    ? structuredClone(db.data.dns_records)
    : [
        { uuid: db.newUuid(), type: 'A', name: '@', content: ip, ttl: 300, proxied: false },
        {
          uuid: db.newUuid(),
          type: 'CNAME',
          name: 'www',
          content: zone.name,
          ttl: 300,
          proxied: false,
        },
        {
          uuid: db.newUuid(),
          type: 'MX',
          name: '@',
          content: `mail.${zone.name}`,
          ttl: 3600,
          priority: 10,
          proxied: false,
        },
        {
          uuid: db.newUuid(),
          type: 'TXT',
          name: '@',
          content: 'v=spf1 mx -all',
          ttl: 3600,
          proxied: false,
        },
      ];
  db.data[key] = rows;
  return rows;
}

function recordError(b: Partial<S['DnsRecordInput']>, zone: S['DnsZone']): string | null {
  const type = b.type as DnsType;
  if (!type) return 'Chọn loại record.';
  if (!b.name || !/^(@|\*|(\*\.)?[a-z0-9_][a-z0-9-_.]*)$/i.test(b.name))
    return 'Tên record không hợp lệ.';
  const e = contentError(type, b.content ?? '');
  if (e) return `Nội dung không hợp lệ cho record ${type}.`;
  if (b.ttl === undefined || b.ttl < 60 || b.ttl > 86400) return 'TTL 60–86400 giây.';
  if ((type === 'MX' || type === 'SRV') && b.priority === undefined)
    return 'Record MX/SRV cần độ ưu tiên.';
  if (b.proxied && (!PROXIABLE.includes(type) || zone.provider !== 'cloudflare')) {
    return 'Chỉ record A/AAAA/CNAME trên zone Cloudflare mới bật proxy được.';
  }
  if (type === 'CNAME' && b.name === '@') return 'Không đặt CNAME ở gốc zone.';
  return null;
}

// ---------------------------------------------------------------- dữ liệu phụ theo website
function nginxOf(db: DemoDb, w: Website): S['WebsiteNginx'] {
  const key = `nginx@${w.uuid}`;
  db.data[key] ??= {
    client_max_body_size: '64m',
    http2: true,
    hsts: w.ssl_mode !== 'none',
    extra_headers: { 'X-Frame-Options': 'SAMEORIGIN' },
    redirects: [],
  };
  return db.data[key] as S['WebsiteNginx'];
}
function phpOf(db: DemoDb, w: Website): S['WebsitePhp'] {
  const key = `php@${w.uuid}`;
  const workers = limitsOf(db, accountOfSite(db, w))?.php_workers_max ?? 4;
  db.data[key] ??= {
    version: w.php_version ?? '8.3',
    memory_limit: '256m',
    max_execution_time: 60,
    upload_max_filesize: '64m',
    pm_max_children: Math.min(4, workers),
    disable_functions: ['exec', 'passthru', 'shell_exec', 'system', 'proc_open', 'popen'],
  };
  return db.data[key] as S['WebsitePhp'];
}
function wafOf(db: DemoDb, w: Website): S['WafSettings'] {
  const key = `waf@${w.uuid}`;
  const base = db.data.waf as S['WafSettings'];
  db.data[key] ??=
    base.website.uuid === w.uuid
      ? structuredClone(base)
      : {
          website: siteRef(w),
          enabled: w.waf_enabled,
          mode: 'detect',
          paranoia_level: 1,
          rule_exclusions: [],
          blocked_24h: w.waf_enabled ? 3 : 0,
          updated_at: w.updated_at,
        };
  return db.data[key] as S['WafSettings'];
}

function runsOf(db: DemoDb, c: S['CronJob']): S['CronRun'][] {
  const key = `runs@${c.uuid}`;
  if (db.data[key]) return db.data[key] as S['CronRun'][];
  const base = db.data.cron_runs;
  const rows: S['CronRun'][] = c.last_run_at
    ? Array.from({ length: 6 }, (_, i) => {
        const start = new Date(Date.parse(c.last_run_at as string) - i * 3_600_000);
        const fail = c.last_status === 'failed' && i === 0;
        const iso = (d: Date) =>
          new Date(d.getTime() + 7 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '+07:00');
        return {
          uuid: db.newUuid(),
          started_at: iso(start),
          finished_at: iso(new Date(start.getTime() + (fail ? 31_000 : 2_800))),
          exit_code: fail ? 1 : 0,
          status: fail ? 'failed' : 'succeeded',
          output_tail: fail
            ? 'PHP Fatal error:  Allowed memory size of 268435456 bytes exhausted'
            : (base[0]?.output_tail ?? 'OK'),
        };
      })
    : [];
  db.data[key] = rows;
  return rows;
}

/** API thật trả mật khẩu do panel sinh MỘT lần trong JobAccepted.secret. */
function withSecret(r: Reply, pw: string | null): Reply {
  if (pw !== null && r.status === 202) (r.body as Record<string, unknown>).secret = pw;
  return r;
}
function secret(len = 20) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#@%';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) => abc[b % abc.length]).join(
    '',
  );
}
const sha = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 7);

/** Mock module Hosting II: website, domain, SSL, Nginx/PHP/WAF, log, DB, file, SFTP/SSH, DNS, cron, WordPress, Git. */
/** Phần chỉ Admin có (DNS, WAF, quét mã độc theo yêu cầu): Portal không đăng ký. */
const ADMIN_ONLY = /^\/api\/v1\/portal\/(dns\/|websites\/\{id\}\/(waf|scans))/;

export function registerSites(realm: 'admin' | 'portal' = 'admin') {
  const P = (p: string) => at(realm, p);
  const on: typeof onRoute = (method, path, fn) => {
    if (!ADMIN_ONLY.test(path)) onRoute(method, path, fn);
  };

  // ============================================================ website
  on('post', P('/websites'), (ctx) => {
    const b = (ctx.body ?? {}) as Partial<S['WebsiteCreate']>;
    const a = accountById(ctx, b.hosting_account_uuid);
    if (isReply(a)) return a;
    const L = limitsOf(ctx.db, a);
    const domain = (b.primary_domain ?? '').toLowerCase();
    if (!DOMAIN.test(domain)) return invalid('Domain không hợp lệ.');
    if (
      ctx.db.data.domains.some((d) => d.name === domain) ||
      ctx.db.data.websites.some((w) => w.primary_domain === domain)
    ) {
      return problem(409, 'conflict', 'Domain đã được dùng trên hệ thống');
    }
    if (!b.type || !['php', 'static', 'proxy'].includes(b.type))
      return invalid('Chọn loại website.');
    const used = ctx.db.data.websites.filter((w) => w.hosting_account.uuid === a.uuid).length;
    if (L && used >= L.website_limit)
      return quota('websites', `Đã dùng ${L.website_limit}/${L.website_limit} websites theo gói.`);
    const php = b.type === 'php' ? (b.php_version ?? L?.php_versions.at(-1) ?? '8.3') : null;
    if (php && L && !L.php_versions.includes(php))
      return limit(`Gói chỉ cho phép PHP ${L.php_versions.join(', ')}.`);
    const root = b.document_root ?? 'public';
    if (normalizePath(root) === null || root.startsWith('/'))
      return invalid('Thư mục gốc phải nằm trong thư mục của site.');
    if (b.type === 'proxy' && !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(b.proxy_target ?? '')) {
      return invalid('Proxy chỉ tới http://127.0.0.1:<cổng> trên cùng máy chủ.');
    }
    const ssl = b.ssl_mode ?? 'acme';
    const w: Website = {
      uuid: ctx.db.newUuid(),
      hosting_account: accRef(a),
      server: a.server,
      primary_domain: domain,
      type: b.type,
      document_root: root,
      php_version: php,
      ssl_mode: ssl,
      waf_enabled: false,
      domains_count: 1,
      certificate_expires_at: null,
      ...fresh(ctx.db),
    } as Website;
    ctx.db.data.websites.push(w);
    ctx.db.data.domains.push({
      uuid: ctx.db.newUuid(),
      website: siteRef(w),
      name: domain,
      type: 'primary',
      verified_at: null,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    });
    a.usage.websites.used += 1;
    const ops = ['fs.mkdir', 'nginx.vhost.apply'];
    if (b.type === 'php') ops.splice(1, 0, 'php.pool.apply');
    if (ssl === 'acme') ops.push('cert.issue');
    return startJob(ctx, {
      type: 'website.create',
      resource: { type: 'website', uuid: w.uuid },
      ops,
      server: a.server,
      changes: { domain, type: b.type, php },
      onDone: (db) => {
        applied(w, db);
        const d = db.data.domains.find((x) => x.website.uuid === w.uuid && x.type === 'primary');
        if (d) d.verified_at = db.now();
        if (ssl === 'acme') {
          const exp = new Date(Date.now() + 90 * 86_400_000 + 7 * 3600_000)
            .toISOString()
            .replace(/\.\d{3}Z$/, '+07:00');
          w.certificate_expires_at = exp;
          db.data.certs.push({
            uuid: db.newUuid(),
            website: siteRef(w),
            source: 'acme',
            domains: [domain],
            issuer: "Let's Encrypt R11",
            not_before: db.now(),
            not_after: exp,
            auto_renew: true,
            status: 'valid',
            created_at: db.now(),
            updated_at: db.now(),
          });
        }
        Reflect.deleteProperty(db.data, `fs@${a.uuid}`);
      },
    });
  });

  on('patch', P('/websites/{id}'), (ctx) => {
    const w = siteOf(ctx);
    if (isReply(w)) return w;
    const b = (ctx.body ?? {}) as S['WebsiteUpdate'];
    const L = limitsOf(ctx.db, accountOfSite(ctx.db, w));
    if (b.php_version !== undefined && b.php_version !== null) {
      if (w.type !== 'php') return invalid('Chỉ website PHP mới đổi phiên bản PHP.');
      if (L && !L.php_versions.includes(b.php_version))
        return limit(`Gói chỉ cho phép PHP ${L.php_versions.join(', ')}.`);
    }
    if (b.document_root !== undefined && normalizePath(b.document_root) === null)
      return invalid('Thư mục gốc không hợp lệ.');
    bump(w, ctx.db);
    w.status = 'provisioning';
    const ops = ['nginx.vhost.apply'];
    if (b.php_version) ops.unshift('php.pool.apply');
    if (b.ssl_mode === 'acme' && w.ssl_mode !== 'acme') ops.push('cert.issue');
    return startJob(ctx, {
      type: 'website.update',
      resource: { type: 'website', uuid: w.uuid },
      ops,
      server: w.server,
      changes: b as Record<string, unknown>,
      onDone: (db) => {
        Object.assign(w, b);
        if (b.php_version) phpOf(db, w).version = b.php_version;
        if (b.waf_enabled !== undefined) wafOf(db, w).enabled = b.waf_enabled;
        applied(w, db);
      },
    });
  });

  on('delete', P('/websites/{id}'), (ctx) => {
    const w = siteOf(ctx);
    if (isReply(w)) return w;
    w.status = 'deleting';
    return startJob(ctx, {
      type: 'website.delete',
      resource: { type: 'website', uuid: w.uuid },
      ops: ['nginx.vhost.remove', 'php.pool.remove'],
      server: w.server,
      changes: { domain: w.primary_domain },
      onDone: (db) => {
        const d = db.data;
        d.websites = d.websites.filter((x) => x.uuid !== w.uuid);
        d.domains = d.domains.filter((x) => x.website.uuid !== w.uuid);
        d.certs = d.certs.filter((x) => x.website.uuid !== w.uuid);
        d.wordpress = (d.wordpress as S['WordPressSite'][]).filter(
          (x) => x.website.uuid !== w.uuid,
        );
        d.git_repositories = (d.git_repositories as GitRepo[]).filter(
          (x) => x.website.uuid !== w.uuid,
        );
        const a = accountOfSite(db, w);
        if (a) a.usage.websites.used = Math.max(0, a.usage.websites.used - 1);
      },
    });
  });

  // Domain phụ
  on('get', P('/websites/{id}/domains'), (ctx) => {
    const w = siteOf(ctx);
    return isReply(w)
      ? w
      : page(
          ctx,
          ctx.db.data.domains.filter((d) => d.website.uuid === w.uuid),
        );
  });
  on('post', P('/websites/{id}/domains'), (ctx) => {
    const w = siteOf(ctx);
    if (isReply(w)) return w;
    const b = (ctx.body ?? {}) as Partial<S['WebsiteDomainCreate']>;
    const name = (b.name ?? '').toLowerCase();
    if (!DOMAIN.test(name)) return invalid('Domain không hợp lệ.');
    if (!b.type || !['alias', 'redirect', 'subdomain'].includes(b.type))
      return invalid('Chọn loại domain.');
    if (ctx.db.data.domains.some((d) => d.name === name))
      return problem(409, 'conflict', 'Domain đã được dùng');
    const L = limitsOf(ctx.db, accountOfSite(ctx.db, w));
    const kind = b.type === 'subdomain' ? 'subdomain' : 'alias';
    const count = ctx.db.data.domains.filter(
      (d) =>
        d.website.uuid === w.uuid &&
        (kind === 'subdomain'
          ? d.type === 'subdomain'
          : d.type === 'alias' || d.type === 'redirect'),
    ).length;
    const max = kind === 'subdomain' ? L?.subdomain_limit : L?.alias_domain_limit;
    if (max !== undefined && count >= max)
      return limit(
        `Gói cho phép tối đa ${max} ${kind === 'subdomain' ? 'subdomain' : 'domain alias'} mỗi site.`,
      );
    const d: S['WebsiteDomain'] = {
      uuid: ctx.db.newUuid(),
      website: siteRef(w),
      name,
      type: b.type,
      verified_at: null,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    };
    ctx.db.data.domains.push(d);
    w.domains_count += 1;
    return startJob(ctx, {
      type: 'website.domain_add',
      resource: { type: 'website', uuid: w.uuid },
      ops: w.ssl_mode === 'acme' ? ['nginx.vhost.apply', 'cert.issue'] : ['nginx.vhost.apply'],
      server: w.server,
      changes: { name, type: b.type },
      onDone: (db) => {
        d.verified_at = db.now();
      },
    });
  });
  on('delete', P('/websites/{id}/domains/{domain}'), (ctx) => {
    const w = siteOf(ctx);
    if (isReply(w)) return w;
    const d = ctx.db.data.domains.find(
      (x) => x.uuid === ctx.params.domain && x.website.uuid === w.uuid,
    );
    if (!d) return notFound('domain');
    if (d.type === 'primary')
      return problem(409, 'conflict', 'Không xóa được domain chính của website');
    return startJob(ctx, {
      type: 'website.domain_remove',
      resource: { type: 'website', uuid: w.uuid },
      ops: ['nginx.vhost.apply'],
      server: w.server,
      changes: { name: d.name },
      onDone: (db) => {
        db.data.domains = db.data.domains.filter((x) => x.uuid !== d.uuid);
        w.domains_count = Math.max(1, w.domains_count - 1);
      },
    });
  });

  // SSL
  on('post', P('/websites/{id}/certificates'), (ctx) => {
    const w = siteOf(ctx);
    if (isReply(w)) return w;
    const b = (ctx.body ?? {}) as Partial<S['CertificateRequest']>;
    const names = ctx.db.data.domains.filter((d) => d.website.uuid === w.uuid).map((d) => d.name);
    if (!b.domains?.length || b.domains.some((d) => !names.includes(d)))
      return invalid('Chứng chỉ chỉ cấp cho domain của website này.');
    if (b.source === 'upload') {
      if (
        !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(b.certificate_pem ?? '')
      )
        return invalid('Chứng chỉ PEM không hợp lệ.');
      if (
        !/-----BEGIN (RSA |EC )?PRIVATE KEY-----[\s\S]+-----END (RSA |EC )?PRIVATE KEY-----/.test(
          b.private_key_pem ?? '',
        )
      )
        return invalid('Khóa riêng PEM không hợp lệ.');
    } else if (b.source !== 'acme') return invalid('Chọn nguồn chứng chỉ.');
    return startJob(ctx, {
      type: b.source === 'acme' ? 'certificate.issue' : 'certificate.upload',
      resource: { type: 'website', uuid: w.uuid },
      ops:
        b.source === 'acme'
          ? ['cert.issue', 'nginx.vhost.apply']
          : ['cert.install', 'nginx.vhost.apply'],
      server: w.server,
      changes: { domains: b.domains, source: b.source },
      onDone: (db) => {
        const exp = new Date(
          Date.now() + (b.source === 'acme' ? 90 : 365) * 86_400_000 + 7 * 3600_000,
        )
          .toISOString()
          .replace(/\.\d{3}Z$/, '+07:00');
        db.data.certs = db.data.certs.filter((c) => c.website.uuid !== w.uuid);
        db.data.certs.push({
          uuid: db.newUuid(),
          website: siteRef(w),
          source: b.source as 'acme' | 'upload',
          domains: b.domains as string[],
          issuer: b.source === 'acme' ? "Let's Encrypt R11" : 'Chứng chỉ tải lên',
          not_before: db.now(),
          not_after: exp,
          auto_renew: b.source === 'acme',
          status: 'valid',
          created_at: db.now(),
          updated_at: db.now(),
        });
        w.ssl_mode = b.source === 'acme' ? 'acme' : 'custom';
        w.certificate_expires_at = exp;
      },
    });
  });
  const certOf = (ctx: Ctx) => {
    const c = ctx.db.data.certs.find((x) => x.uuid === ctx.params.id);
    const w = ctx.db.data.websites.find((x) => x.uuid === c?.website.uuid);
    const v = visibility(ctx.db, ctx.actor);
    return c && w && canSeeAccount(v, w.hosting_account.uuid) ? { c, w } : notFound('chứng chỉ');
  };
  on('post', P('/certificates/{id}:renew'), (ctx) => {
    const r = certOf(ctx);
    if (isReply(r)) return r;
    if (r.c.source !== 'acme')
      return problem(409, 'conflict', 'Chứng chỉ tải lên không tự gia hạn; hãy tải chứng chỉ mới');
    return startJob(ctx, {
      type: 'website.ssl.renew',
      resource: { type: 'website', uuid: r.w.uuid },
      ops: ['cert.issue', 'nginx.vhost.apply'],
      server: r.w.server,
      onDone: (db) => {
        r.c.not_before = db.now();
        r.c.not_after = new Date(Date.now() + 90 * 86_400_000 + 7 * 3600_000)
          .toISOString()
          .replace(/\.\d{3}Z$/, '+07:00');
        r.c.status = 'valid';
        r.c.updated_at = db.now();
        r.w.certificate_expires_at = r.c.not_after;
      },
    });
  });
  on('delete', P('/certificates/{id}'), (ctx) => {
    const r = certOf(ctx);
    if (isReply(r)) return r;
    return startJob(ctx, {
      type: 'certificate.delete',
      resource: { type: 'website', uuid: r.w.uuid },
      ops: ['nginx.vhost.apply'],
      server: r.w.server,
      onDone: (db) => {
        db.data.certs = db.data.certs.filter((x) => x.uuid !== r.c.uuid);
        r.w.ssl_mode = 'none';
        r.w.certificate_expires_at = null;
      },
    });
  });

  // Nginx / PHP / WAF theo site
  on('get', P('/websites/{id}/nginx'), (ctx) => {
    const w = siteOf(ctx);
    return isReply(w) ? w : ok(nginxOf(ctx.db, w));
  });
  on('patch', P('/websites/{id}/nginx'), (ctx) => {
    const w = siteOf(ctx);
    if (isReply(w)) return w;
    const b = (ctx.body ?? {}) as S['WebsiteNginx'];
    if (b.client_max_body_size !== undefined && !SIZE.test(b.client_max_body_size))
      return invalid('Kích thước dạng 64m, 512k, 1g.');
    for (const r of b.redirects ?? []) {
      if (normalizePath(r.from) === null || !/^https?:\/\//.test(r.to))
        return invalid('Chuyển hướng: đường dẫn nguồn trong site, đích là URL http(s).');
    }
    for (const [k, v] of Object.entries(b.extra_headers ?? {})) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || /[\r\n]/.test(v))
        return invalid('Header không hợp lệ.');
    }
    bump(w, ctx.db);
    return startJob(ctx, {
      type: 'website.nginx_update',
      resource: { type: 'website', uuid: w.uuid },
      ops: ['nginx.vhost.apply'],
      server: w.server,
      changes: b as Record<string, unknown>,
      onDone: (db) => {
        Object.assign(nginxOf(db, w), b);
        applied(w, db);
      },
    });
  });
  on('get', P('/websites/{id}/php'), (ctx) => {
    const w = siteOf(ctx);
    if (isReply(w)) return w;
    if (w.type !== 'php') return problem(409, 'conflict', 'Website không chạy PHP');
    return ok(phpOf(ctx.db, w));
  });
  on('patch', P('/websites/{id}/php'), (ctx) => {
    const w = siteOf(ctx);
    if (isReply(w)) return w;
    if (w.type !== 'php') return problem(409, 'conflict', 'Website không chạy PHP');
    const b = (ctx.body ?? {}) as S['WebsitePhp'];
    const L = limitsOf(ctx.db, accountOfSite(ctx.db, w));
    if (b.version && L && !L.php_versions.includes(b.version))
      return limit(`Gói chỉ cho phép PHP ${L.php_versions.join(', ')}.`);
    if (b.pm_max_children !== undefined && L && b.pm_max_children > L.php_workers_max)
      return limit(`Gói cho tối đa ${L.php_workers_max} PHP worker.`);
    for (const k of ['memory_limit', 'upload_max_filesize'] as const)
      if (b[k] !== undefined && !SIZE.test(b[k] as string)) return invalid('Kích thước dạng 256m.');
    if (
      b.max_execution_time !== undefined &&
      (b.max_execution_time < 1 || b.max_execution_time > 3600)
    )
      return invalid('Thời gian chạy 1–3600 giây.');
    bump(w, ctx.db);
    return startJob(ctx, {
      type: 'website.php_update',
      resource: { type: 'website', uuid: w.uuid },
      ops: ['php.pool.apply'],
      server: w.server,
      changes: b as Record<string, unknown>,
      onDone: (db) => {
        Object.assign(phpOf(db, w), b);
        if (b.version) w.php_version = b.version;
        applied(w, db);
      },
    });
  });
  on('get', P('/websites/{id}/waf'), (ctx) => {
    const w = siteOf(ctx);
    return isReply(w) ? w : ok(wafOf(ctx.db, w));
  });
  on('patch', P('/websites/{id}/waf'), (ctx) => {
    const w = siteOf(ctx);
    if (isReply(w)) return w;
    const b = (ctx.body ?? {}) as S['WafUpdate'];
    if (b.paranoia_level !== undefined && (b.paranoia_level < 1 || b.paranoia_level > 4))
      return invalid('Mức paranoia 1–4.');
    if ((b.rule_exclusions ?? []).some((r) => !/^\d{6}$/.test(r)))
      return invalid('Mã rule OWASP CRS gồm 6 chữ số.');
    return startJob(ctx, {
      type: 'website.waf_update',
      resource: { type: 'website', uuid: w.uuid },
      ops: ['waf.apply', 'nginx.vhost.apply'],
      server: w.server,
      changes: b as Record<string, unknown>,
      onDone: (db) => {
        const waf = wafOf(db, w);
        Object.assign(waf, b);
        waf.updated_at = db.now();
        w.waf_enabled = waf.enabled;
      },
    });
  });
  on('get', P('/websites/{id}/logs'), (ctx) => {
    const w = siteOf(ctx);
    if (isReply(w)) return w;
    const kind = ctx.query.get('kind');
    if (kind !== 'access' && kind !== 'error') return invalid('kind = access hoặc error.');
    const n = Math.min(Number(ctx.query.get('lines') ?? 200) || 200, 2000);
    const paths = ['/', '/san-pham', '/lien-he', '/wp-login.php', '/api/orders', '/assets/app.js'];
    const lines = Array.from({ length: Math.min(n, 60) }, (_, i) => {
      const t = `20/Nov/2026:08:${String(15 - Math.floor(i / 4)).padStart(2, '0')}:${String((59 - i * 7) % 60).padStart(2, '0')} +0700`;
      if (kind === 'error') {
        return i % 3 === 0
          ? `2026/11/20 08:${String(14 - Math.floor(i / 3)).padStart(2, '0')}:02 [error] ${NGX_PID}: *${9000 - i} FastCGI sent in stderr: "PHP Warning:  Undefined array key \\"page\\" in /home/${w.hosting_account.username}/sites/${w.primary_domain}/public/index.php on line 42"`
          : `2026/11/20 08:${String(14 - Math.floor(i / 3)).padStart(2, '0')}:10 [warn] ${NGX_PID}: *${9000 - i} upstream response is buffered to a temporary file`;
      }
      const p = paths[i % paths.length] as string;
      const code = p === '/wp-login.php' ? 403 : i % 11 === 0 ? 404 : 200;
      return `203.0.113.${(i * 13) % 250} - - [${t}] "GET ${p} HTTP/2.0" ${code} ${1000 + ((i * 397) % 9000)} "-" "Mozilla/5.0"`;
    });
    return ok(lines);
  });
  on('post', P('/websites/{id}/scans'), (ctx) => {
    const w = siteOf(ctx);
    if (isReply(w)) return w;
    return startJob(ctx, {
      type: 'security.scan',
      resource: { type: 'website', uuid: w.uuid },
      ops: ['malware.scan'],
      server: w.server,
      onDone: (db) => {
        // Kết quả quét hiện ở /security/malware (sạch: 0 phát hiện).
        (db.data.malware_scans as S['MalwareScan'][]).unshift({
          uuid: db.newUuid(),
          website: siteRef(w),
          hosting_account: w.hosting_account,
          engine: 'clamav+yara',
          state: 'succeeded',
          files_scanned: 1200 + w.primary_domain.length * 97,
          findings: 0,
          started_at: db.now(),
          finished_at: db.now(),
        });
      },
    });
  });

  // ============================================================ database
  on('post', P('/databases'), (ctx) => {
    const b = (ctx.body ?? {}) as Partial<S['DatabaseCreate']>;
    const a = accountById(ctx, b.hosting_account_uuid);
    if (isReply(a)) return a;
    const L = limitsOf(ctx.db, a);
    if (!b.name || !DB_NAME.test(b.name) || !b.name.startsWith(`${a.username}_`))
      return invalid(
        `Tên database phải bắt đầu bằng "${a.username}_" và chỉ gồm chữ thường, số, gạch dưới.`,
      );
    if (!b.engine || !['mariadb', 'mysql', 'postgresql'].includes(b.engine))
      return invalid('Chọn engine.');
    if (ctx.db.data.databases.some((d) => d.name === b.name && d.engine === b.engine))
      return problem(409, 'conflict', 'Database đã tồn tại');
    const used = ctx.db.data.databases.filter((d) => d.hosting_account.uuid === a.uuid).length;
    if (L && used >= L.database_limit)
      return quota(
        'databases',
        `Đã dùng ${L.database_limit}/${L.database_limit} databases theo gói.`,
      );
    const d: S['Database'] = {
      uuid: ctx.db.newUuid(),
      hosting_account: accRef(a),
      server: a.server,
      engine: b.engine,
      name: b.name,
      size_mb: 0,
      charset: b.engine === 'postgresql' ? 'UTF8' : 'utf8mb4',
      users: b.create_user ? [b.name] : [],
      ...fresh(ctx.db),
    };
    ctx.db.data.databases.push(d);
    a.usage.databases.used += 1;
    const pg = b.engine === 'postgresql';
    const ops = [pg ? 'db.pg.create' : 'db.mysql.create'];
    if (b.create_user)
      ops.push(
        pg ? 'db.pg.user_ensure' : 'db.mysql.user_ensure',
        pg ? 'db.pg.grant' : 'db.mysql.grant',
      );
    return withSecret(
      startJob(ctx, {
        type: 'database.create',
        resource: { type: 'database', uuid: d.uuid },
        ops,
        server: a.server,
        changes: { name: b.name, engine: b.engine },
        onDone: (db) => {
          applied(d, db);
          if (b.create_user && !db.data.db_users.some((u) => u.username === b.name)) {
            db.data.db_users.push({
              uuid: db.newUuid(),
              hosting_account: accRef(a),
              engine: b.engine as S['Database']['engine'],
              username: b.name as string,
              host: 'localhost',
              max_connections: 10,
              grants: [{ database: b.name as string, privileges: ['ALL'] }],
              ...fresh(db),
            });
          }
        },
      }),
      b.create_user ? secret(24) : null,
    );
  });
  const dbOf = (ctx: Ctx) => owned(ctx, ctx.db.data.databases, 'database');
  on('delete', P('/databases/{id}'), (ctx) => {
    const d = dbOf(ctx);
    if (isReply(d)) return d;
    d.status = 'deleting';
    return startJob(ctx, {
      type: 'database.delete',
      resource: { type: 'database', uuid: d.uuid },
      ops: ['backup.run', d.engine === 'postgresql' ? 'db.pg.drop' : 'db.mysql.drop'],
      server: d.server,
      changes: { name: d.name },
      onDone: (db) => {
        db.data.databases = db.data.databases.filter((x) => x.uuid !== d.uuid);
        for (const u of db.data.db_users) u.grants = u.grants.filter((g) => g.database !== d.name);
        const a = db.data.accounts.find((x) => x.uuid === d.hosting_account.uuid);
        if (a) a.usage.databases.used = Math.max(0, a.usage.databases.used - 1);
      },
    });
  });
  on('post', P('/databases/{id}:export'), (ctx) => {
    const d = dbOf(ctx);
    if (isReply(d)) return d;
    return startJob(ctx, {
      type: 'database.export',
      resource: { type: 'database', uuid: d.uuid },
      ops: [d.engine === 'postgresql' ? 'db.pg.dump' : 'db.mysql.dump'],
      server: d.server,
      changes: { file: `backups/${d.name}-20261120.sql.gz` },
      onDone: (db) => {
        const a = db.data.accounts.find((x) => x.uuid === d.hosting_account.uuid);
        if (!a) return;
        const fs = fsOf(db, a);
        const path = `backups/${d.name}-20261120.sql.gz`;
        fs[path] = {
          entry: {
            name: path.split('/')[1] as string,
            path,
            type: 'file',
            size: Math.round(d.size_mb * 180_000) + 1024,
            mode: '0600',
            owner: a.username,
            modified_at: db.now(),
          },
        };
      },
    });
  });
  on('post', P('/databases/{id}:import'), (ctx) => {
    const d = dbOf(ctx);
    if (isReply(d)) return d;
    const a = ctx.db.data.accounts.find((x) => x.uuid === d.hosting_account.uuid) as Account;
    const raw = (ctx.body as { path?: string } | undefined)?.path;
    const path = raw === undefined ? null : normalizePath(raw);
    if (path === null) return invalid('Đường dẫn file nằm ngoài thư mục home.');
    const f = fsOf(ctx.db, a)[path];
    if (!f || f.entry.type !== 'file' || !/\.sql(\.gz)?$/.test(path))
      return invalid('Chọn file .sql hoặc .sql.gz có trong thư mục home.');
    return startJob(ctx, {
      type: 'database.import',
      resource: { type: 'database', uuid: d.uuid },
      ops: ['backup.run', d.engine === 'postgresql' ? 'db.pg.import' : 'db.mysql.import'],
      server: d.server,
      changes: { path },
    });
  });

  on('post', P('/database-users'), (ctx) => {
    const b = (ctx.body ?? {}) as Partial<S['DatabaseUserCreate']>;
    const a = accountById(ctx, b.hosting_account_uuid);
    if (isReply(a)) return a;
    const L = limitsOf(ctx.db, a);
    if (!b.username || !DB_NAME.test(b.username) || !b.username.startsWith(`${a.username}_`))
      return invalid(`Tên user phải bắt đầu bằng "${a.username}_".`);
    if (ctx.db.data.db_users.some((u) => u.username === b.username))
      return problem(409, 'conflict', 'User database đã tồn tại');
    if (b.password != null && b.password.length < 12)
      return invalid('Mật khẩu tối thiểu 12 ký tự (để trống để panel tự sinh).');
    const used = ctx.db.data.db_users.filter((u) => u.hosting_account.uuid === a.uuid).length;
    if (L && used >= L.db_user_limit)
      return limit(`Gói cho phép tối đa ${L.db_user_limit} user database.`);
    const u: S['DatabaseUser'] = {
      uuid: ctx.db.newUuid(),
      hosting_account: accRef(a),
      engine: b.engine ?? 'mariadb',
      username: b.username,
      host: b.host ?? 'localhost',
      max_connections: b.max_connections ?? 10,
      grants: [],
      ...fresh(ctx.db),
    };
    ctx.db.data.db_users.push(u);
    return withSecret(
      startJob(ctx, {
        type: 'database_user.create',
        resource: { type: 'database_user', uuid: u.uuid },
        ops: [u.engine === 'postgresql' ? 'db.pg.user_ensure' : 'db.mysql.user_ensure'],
        server: a.server,
        changes: { username: u.username },
      }),
      b.password ? null : secret(24),
    );
  });
  const dbUserOf = (ctx: Ctx) => owned(ctx, ctx.db.data.db_users, 'user database');
  on('delete', P('/database-users/{id}'), (ctx) => {
    const u = dbUserOf(ctx);
    if (isReply(u)) return u;
    const a = ctx.db.data.accounts.find((x) => x.uuid === u.hosting_account.uuid);
    return startJob(ctx, {
      type: 'database_user.delete',
      resource: { type: 'database_user', uuid: u.uuid },
      ops: [u.engine === 'postgresql' ? 'db.pg.user_drop' : 'db.mysql.user_drop'],
      server: a?.server ?? null,
      onDone: (db) => {
        db.data.db_users = db.data.db_users.filter((x) => x.uuid !== u.uuid);
        for (const d of db.data.databases) d.users = d.users.filter((x) => x !== u.username);
      },
    });
  });
  on('put', P('/database-users/{id}/grants'), (ctx) => {
    const u = dbUserOf(ctx);
    if (isReply(u)) return u;
    const grants = ((ctx.body ?? {}) as { grants?: S['DatabaseGrant'][] }).grants ?? [];
    const mine = ctx.db.data.databases.filter(
      (d) => d.hosting_account.uuid === u.hosting_account.uuid && d.engine === u.engine,
    );
    for (const g of grants) {
      if (!mine.some((d) => d.name === g.database))
        return invalid(`Database ${g.database} không thuộc tài khoản này.`);
      if (!g.privileges.length) return invalid('Chọn ít nhất một quyền.');
    }
    const a = ctx.db.data.accounts.find((x) => x.uuid === u.hosting_account.uuid);
    return startJob(ctx, {
      type: 'database_user.grant',
      resource: { type: 'database_user', uuid: u.uuid },
      ops: [u.engine === 'postgresql' ? 'db.pg.grant' : 'db.mysql.grant'],
      server: a?.server ?? null,
      changes: { grants },
      onDone: (db) => {
        u.grants = grants;
        u.updated_at = db.now();
        for (const d of db.data.databases.filter(
          (x) => x.hosting_account.uuid === u.hosting_account.uuid,
        )) {
          const has = grants.some((g) => g.database === d.name);
          d.users = has
            ? [...new Set([...d.users, u.username])]
            : d.users.filter((x) => x !== u.username);
        }
      },
    });
  });
  on('post', P('/database-users/{id}:rotate-password'), (ctx) => {
    const u = dbUserOf(ctx);
    if (isReply(u)) return u;
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'database_user.rotate_password',
      resource: { type: 'database_user', uuid: u.uuid },
    });
    return ok({ secret: secret(24) });
  });

  // ============================================================ File Manager (trong home)
  const fileAccount = (ctx: Ctx) => {
    const a = ctx.db.data.accounts.find((x) => x.uuid === ctx.params.id);
    const v = visibility(ctx.db, ctx.actor);
    return a && canSeeAccount(v, a.uuid) ? a : notFound('tài khoản hosting');
  };
  on('get', P('/hosting-accounts/{id}/files'), (ctx) => {
    const a = fileAccount(ctx);
    if (isReply(a)) return a;
    const p = relPath(a, ctx.query.get('path'));
    if (isReply(p)) return p;
    const fs = fsOf(ctx.db, a);
    if (p !== '.' && fs[p]?.entry.type !== 'dir') return notFound('thư mục');
    return page(ctx, children(fs, p));
  });
  on('get', P('/hosting-accounts/{id}/files/content'), (ctx) => {
    const a = fileAccount(ctx);
    if (isReply(a)) return a;
    const p = relPath(a, ctx.query.get('path'));
    if (isReply(p)) return p;
    const n = fsOf(ctx.db, a)[p];
    if (!n || n.entry.type !== 'file') return notFound('file');
    if (n.entry.size > 2_000_000 && n.content === undefined)
      return problem(409, 'conflict', 'File quá lớn để mở trong trình soạn thảo');
    return ok({ path: p, content: n.content ?? '', encoding: 'utf-8', etag: etag(n) });
  });
  on('put', P('/hosting-accounts/{id}/files/content'), (ctx) => {
    const a = fileAccount(ctx);
    if (isReply(a)) return a;
    const b = (ctx.body ?? {}) as Partial<S['FileWrite']>;
    const p = relPath(a, b.path);
    if (isReply(p)) return p;
    if (p === '.') return invalid('Không ghi đè thư mục gốc.');
    const fs = fsOf(ctx.db, a);
    const parent = parentPath(p);
    if (parent !== '.' && fs[parent]?.entry.type !== 'dir')
      return invalid('Thư mục cha không tồn tại.');
    const n = fs[p];
    if (n && n.entry.type !== 'file') return problem(409, 'conflict', 'Đường dẫn là thư mục');
    if (n && b.if_etag && b.if_etag !== etag(n))
      return problem(
        412,
        'precondition_failed',
        'File đã bị thay đổi bởi người khác; tải lại trước khi lưu',
      );
    const content = b.content ?? '';
    const size = new TextEncoder().encode(content).length;
    const node: Node = n ?? {
      entry: {
        name: p.split('/').at(-1) as string,
        path: p,
        type: 'file',
        size,
        mode: '0640',
        owner: a.username,
        modified_at: ctx.db.now(),
      },
    };
    node.content = content;
    node.entry.size = size;
    node.entry.modified_at = ctx.db.now();
    fs[p] = node;
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'file.write',
      resource: { type: 'hosting_account', uuid: a.uuid },
      server: a.server,
      changes: { path: p, size },
    });
    return ok(node.entry);
  });
  on('get', P('/hosting-accounts/{id}/files/download'), (ctx) => {
    const a = fileAccount(ctx);
    if (isReply(a)) return a;
    const p = relPath(a, ctx.query.get('path'));
    if (isReply(p)) return p;
    if (!fsOf(ctx.db, a)[p]) return notFound('file');
    const exp = new Date(Date.now() + 15 * 60_000 + 7 * 3600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, '+07:00');
    return ok({
      url: `https://panel.itso.local/dl/files/${a.username}/${encodeURIComponent(p)}?sig=demo`,
      expires_at: exp,
    });
  });
  on('post', P('/hosting-accounts/{id}/files/uploads'), (ctx) => {
    const a = fileAccount(ctx);
    if (isReply(a)) return a;
    const b = (ctx.body ?? {}) as Partial<S['UploadCreate']>;
    const p = relPath(a, b.path);
    if (isReply(p)) return p;
    const fs = fsOf(ctx.db, a);
    if (!b.size || b.size < 1) return invalid('Kích thước file không hợp lệ.');
    if (fs[p] && !b.overwrite) return problem(409, 'conflict', 'File đã tồn tại');
    const free = (a.usage.disk_mb.limit - a.usage.disk_mb.used) * 1_048_576;
    if (b.size > free) return problem(422, 'quota_exceeded', 'Vượt dung lượng đĩa của gói');
    const up: S['UploadSession'] = {
      uuid: ctx.db.newUuid(),
      path: p,
      size: b.size,
      chunk_size: 8_388_608,
      received: 0,
      status: 'receiving',
      job_uuid: null,
      expires_at: new Date(Date.now() + 3600_000 + 7 * 3600_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, '+07:00'),
    };
    ctx.db.data[`upload@${up.uuid}`] = { up, account: a.uuid };
    return created(up);
  });
  on('patch', P('/hosting-accounts/{id}/files/uploads/{upload}'), async (ctx) => {
    const a = fileAccount(ctx);
    if (isReply(a)) return a;
    const s = ctx.db.data[`upload@${ctx.params.upload}`] as
      { up: S['UploadSession']; account: string } | undefined;
    if (!s || s.account !== a.uuid) return notFound('phiên tải lên');
    if (s.up.status !== 'receiving') return problem(409, 'conflict', 'Phiên tải lên đã kết thúc');
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(ctx.request.headers.get('Content-Range') ?? '');
    if (range && Number(range[1]) !== s.up.received) {
      // Như API thật: lệch offset → 409 kèm errors.received để client gửi tiếp đúng chỗ.
      const r = problem(409, 'conflict', 'Sai vị trí chunk');
      (r.body as Record<string, unknown>).errors = { received: [String(s.up.received)] };
      return r;
    }
    const len = range
      ? Number(range[2]) - Number(range[1]) + 1
      : (await ctx.request.clone().arrayBuffer()).byteLength;
    s.up.received = Math.min(s.up.size, s.up.received + len);
    if (s.up.received >= s.up.size) s.up.status = 'completed';
    if (s.up.received >= s.up.size) {
      const fs = fsOf(ctx.db, a);
      fs[s.up.path] = {
        entry: {
          name: s.up.path.split('/').at(-1) as string,
          path: s.up.path,
          type: 'file',
          size: s.up.size,
          mode: '0640',
          owner: a.username,
          modified_at: ctx.db.now(),
        },
      };
      a.usage.disk_mb.used += Math.ceil(s.up.size / 1_048_576);
    }
    return ok(s.up);
  });
  on('get', P('/hosting-accounts/{id}/files/uploads/{upload}'), (ctx) => {
    const a = fileAccount(ctx);
    if (isReply(a)) return a;
    const s = ctx.db.data[`upload@${ctx.params.upload}`] as
      { up: S['UploadSession']; account: string } | undefined;
    if (!s || s.account !== a.uuid) return notFound('phiên tải lên');
    return ok(s.up);
  });
  on('delete', P('/hosting-accounts/{id}/files/uploads/{upload}'), (ctx) => {
    const a = fileAccount(ctx);
    if (isReply(a)) return a;
    const s = ctx.db.data[`upload@${ctx.params.upload}`] as
      { up: S['UploadSession']; account: string } | undefined;
    if (!s || s.account !== a.uuid) return notFound('phiên tải lên');
    if (s.up.status === 'receiving') s.up.status = 'cancelled';
    return noContent();
  });
  on('post', P('/hosting-accounts/{id}/files:operate'), (ctx) => {
    const a = fileAccount(ctx);
    if (isReply(a)) return a;
    const b = (ctx.body ?? {}) as Partial<S['FileOperation']>;
    const fs = fsOf(ctx.db, a);
    const paths: string[] = [];
    for (const raw of b.paths ?? []) {
      const p = normalizePath(raw, a.home_path);
      if (p === null) return invalid('Đường dẫn nằm ngoài thư mục home của tài khoản.');
      paths.push(p);
    }
    if (!paths.length) return invalid('Chọn ít nhất một mục.');
    const target =
      b.target === undefined || b.target === null ? null : normalizePath(b.target, a.home_path);
    if (b.target && target === null) return invalid('Đích nằm ngoài thư mục home của tài khoản.');
    const op = b.op;
    if (op !== 'mkdir') {
      if (paths.includes('.')) return invalid('Không thao tác trên thư mục gốc.');
      for (const p of paths) if (!fs[p]) return notFound(`"${p}"`);
    }
    if (op === 'mkdir') {
      for (const p of paths) {
        if (fs[p]) return problem(409, 'conflict', `"${p}" đã tồn tại`);
        if (!isValidName(p.split('/').at(-1) ?? '')) return invalid('Tên thư mục không hợp lệ.');
        const parent = parentPath(p);
        if (parent !== '.' && fs[parent]?.entry.type !== 'dir')
          return invalid('Thư mục cha không tồn tại.');
      }
    }
    if (
      (op === 'move' || op === 'copy' || op === 'compress' || op === 'extract') &&
      target === null
    )
      return invalid('Chọn thư mục đích.');
    if ((op === 'move' || op === 'copy') && target !== null) {
      if (target !== '.' && fs[target]?.entry.type !== 'dir')
        return invalid('Thư mục đích không tồn tại.');
      for (const p of paths) {
        if (fs[p]?.entry.type === 'dir' && isInside(target, p))
          return invalid('Không chuyển thư mục vào chính nó.');
        if (fs[joinPath(target, p.split('/').at(-1) as string)])
          return problem(409, 'conflict', 'Đích đã có mục cùng tên');
      }
    }
    if (op === 'chmod' && !/^0[0-7]{3}$/.test(b.mode ?? '')) return invalid('Quyền dạng 0644.');
    if (op === 'extract' && paths.some((p) => !/\.(zip|tar\.gz|tgz)$/.test(p)))
      return invalid('Chỉ giải nén .zip hoặc .tar.gz.');
    if (op === 'compress' && (!b.format || !target || fs[target]))
      return invalid('Chọn định dạng và tên file nén chưa tồn tại.');
    const OPS: Record<string, string> = {
      mkdir: 'fs.mkdir',
      move: 'fs.move',
      copy: 'fs.copy',
      delete: 'fs.delete',
      chmod: 'fs.chmod',
      compress: 'fs.archive',
      extract: 'fs.extract',
    };
    if (!op || !OPS[op]) return invalid('Thao tác không hợp lệ.');
    return startJob(ctx, {
      type: `file.${op}`,
      resource: { type: 'hosting_account', uuid: a.uuid },
      ops: [OPS[op] as string],
      server: a.server,
      changes: { paths, target, mode: b.mode ?? null },
      onDone: (db) => {
        const f = fsOf(db, a);
        const now = db.now();
        const under = (p: string) => Object.keys(f).filter((k) => k === p || k.startsWith(`${p}/`));
        if (op === 'mkdir') {
          for (const p of paths)
            f[p] = {
              entry: {
                name: p.split('/').at(-1) as string,
                path: p,
                type: 'dir',
                size: 4096,
                mode: '0750',
                owner: a.username,
                modified_at: now,
              },
            };
        } else if (op === 'delete') {
          for (const p of paths) for (const k of under(p)) Reflect.deleteProperty(f, k);
        } else if (op === 'chmod') {
          for (const p of paths) if (f[p]) f[p].entry.mode = b.mode as string;
        } else if ((op === 'move' || op === 'copy') && target !== null) {
          for (const p of paths) {
            const dest = joinPath(target, p.split('/').at(-1) as string);
            for (const k of under(p)) {
              const nk = dest + k.slice(p.length);
              const n = structuredClone(f[k] as Node);
              n.entry.path = nk;
              n.entry.name = nk.split('/').at(-1) as string;
              n.entry.modified_at = now;
              f[nk] = n;
              if (op === 'move') Reflect.deleteProperty(f, k);
            }
          }
        } else if (op === 'compress' && target) {
          const size = paths.reduce(
            (s, p) =>
              s +
              under(p).reduce(
                (t, k) =>
                  t + ((f[k] as Node).entry.type === 'file' ? (f[k] as Node).entry.size : 0),
                0,
              ),
            0,
          );
          f[target] = {
            entry: {
              name: target.split('/').at(-1) as string,
              path: target,
              type: 'file',
              size: Math.max(512, Math.round(size * 0.35)),
              mode: '0640',
              owner: a.username,
              modified_at: now,
            },
          };
        } else if (op === 'extract' && target) {
          for (const p of paths) {
            const dir = joinPath(
              target,
              (p.split('/').at(-1) as string).replace(/\.(zip|tar\.gz|tgz)$/, ''),
            );
            if (!f[dir])
              f[dir] = {
                entry: {
                  name: dir.split('/').at(-1) as string,
                  path: dir,
                  type: 'dir',
                  size: 4096,
                  mode: '0750',
                  owner: a.username,
                  modified_at: now,
                },
              };
          }
        }
      },
    });
  });

  // ============================================================ SFTP / SSH key
  on('post', P('/sftp-accounts'), (ctx) => {
    const b = (ctx.body ?? {}) as Partial<S['SftpAccountCreate']>;
    const a = accountById(ctx, b.hosting_account_uuid);
    if (isReply(a)) return a;
    const L = limitsOf(ctx.db, a);
    if (
      !b.username ||
      !/^[a-z][a-z0-9_]{2,31}$/.test(b.username) ||
      !b.username.startsWith(`${a.username}_`)
    )
      return invalid(`Username phải bắt đầu bằng "${a.username}_".`);
    if (ctx.db.data.sftp.some((x) => x.username === b.username))
      return problem(409, 'conflict', 'Username SFTP đã tồn tại');
    const root = b.root_path === undefined ? null : normalizePath(b.root_path, a.home_path);
    if (root === null) return invalid('Thư mục gốc phải nằm trong home của tài khoản.');
    if (b.password !== undefined && b.password !== null && b.password.length < 16)
      return invalid('Mật khẩu tối thiểu 16 ký tự.');
    const used = ctx.db.data.sftp.filter((x) => x.hosting_account.uuid === a.uuid).length;
    if (L && used >= L.ftp_limit)
      return quota('ftp_accounts', `Đã dùng ${L.ftp_limit}/${L.ftp_limit} ftp_accounts theo gói.`);
    const s: S['SftpAccount'] = {
      uuid: ctx.db.newUuid(),
      hosting_account: accRef(a),
      username: b.username,
      protocol: b.protocol ?? 'sftp',
      root_path: root,
      read_only: b.read_only ?? false,
      last_login_at: null,
      ...fresh(ctx.db),
    };
    ctx.db.data.sftp.push(s);
    a.usage.ftp_accounts.used += 1;
    return withSecret(
      startJob(ctx, {
        type: 'sftp.create',
        resource: { type: 'sftp_account', uuid: s.uuid },
        ops: ['sftp.user.ensure'],
        server: a.server,
        changes: { username: s.username, root_path: root },
        onDone: (db) => applied(s, db),
      }),
      b.password ? null : secret(24),
    );
  });
  on('delete', P('/sftp-accounts/{id}'), (ctx) => {
    const s = owned(ctx, ctx.db.data.sftp, 'tài khoản SFTP');
    if (isReply(s)) return s;
    const a = ctx.db.data.accounts.find((x) => x.uuid === s.hosting_account.uuid);
    s.status = 'deleting';
    return startJob(ctx, {
      type: 'sftp.delete',
      resource: { type: 'sftp_account', uuid: s.uuid },
      ops: ['sftp.user.remove'],
      server: a?.server ?? null,
      onDone: (db) => {
        db.data.sftp = db.data.sftp.filter((x) => x.uuid !== s.uuid);
        if (a) a.usage.ftp_accounts.used = Math.max(0, a.usage.ftp_accounts.used - 1);
      },
    });
  });
  on('post', P('/sftp-accounts/{id}:rotate-password'), (ctx) => {
    const s = owned(ctx, ctx.db.data.sftp, 'tài khoản SFTP');
    if (isReply(s)) return s;
    const a = ctx.db.data.accounts.find((x) => x.uuid === s.hosting_account.uuid);
    return withSecret(
      startJob(ctx, {
        type: 'sftp_account.rotate_password',
        resource: { type: 'sftp_account', uuid: s.uuid },
        ops: ['sftp.user.ensure'],
        server: a?.server ?? null,
      }),
      secret(24),
    );
  });
  on('post', P('/ssh-keys'), (ctx) => {
    const b = (ctx.body ?? {}) as Partial<S['SshKeyCreate']>;
    const a = accountById(ctx, b.hosting_account_uuid);
    if (isReply(a)) return a;
    if (!limitsOf(ctx.db, a)?.ssh_allowed) return limit('Gói của tài khoản không cho phép SSH.');
    const m =
      /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) ([A-Za-z0-9+/=]{16,})( [^\r\n]{0,100})?$/.exec(
        (b.public_key ?? '').trim(),
      );
    if (!m)
      return invalid(
        'Khóa công khai OpenSSH không hợp lệ (ssh-ed25519, ecdsa-sha2-nistp256, ssh-rsa).',
      );
    if (!b.name || b.name.length > 80) return invalid('Đặt tên cho khóa (≤ 80 ký tự).');
    const fp = `SHA256:${btoa((m[2] as string).slice(-32))
      .replace(/=+$/, '')
      .slice(0, 43)}`;
    if (ctx.db.data.ssh_keys.some((k) => k.fingerprint === fp && k.hosting_account.uuid === a.uuid))
      return problem(409, 'conflict', 'Khóa đã được thêm');
    const k: S['SshKey'] = {
      uuid: ctx.db.newUuid(),
      hosting_account: accRef(a),
      name: b.name,
      fingerprint: fp,
      type: m[1] as S['SshKey']['type'],
      last_used_at: null,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    };
    ctx.db.data.ssh_keys.push(k);
    return startJob(ctx, {
      type: 'ssh_key.create',
      resource: { type: 'ssh_key', uuid: k.uuid },
      ops: ['ssh.keys.apply'],
      server: a.server,
      changes: { name: k.name, fingerprint: fp },
    });
  });
  on('delete', P('/ssh-keys/{id}'), (ctx) => {
    const k = owned(ctx, ctx.db.data.ssh_keys, 'SSH key');
    if (isReply(k)) return k;
    const a = ctx.db.data.accounts.find((x) => x.uuid === k.hosting_account.uuid);
    return startJob(ctx, {
      type: 'ssh_key.delete',
      resource: { type: 'ssh_key', uuid: k.uuid },
      ops: ['ssh.keys.apply'],
      server: a?.server ?? null,
      onDone: (db) => {
        db.data.ssh_keys = db.data.ssh_keys.filter((x) => x.uuid !== k.uuid);
      },
    });
  });

  // ============================================================ DNS
  const zoneOf = (ctx: Ctx) => {
    const z = ctx.db.data.dns_zones.find((x) => x.uuid === ctx.params.id);
    const v = visibility(ctx.db, ctx.actor);
    const okZone =
      z && (v.all || (z.hosting_account !== null && canSeeAccount(v, z.hosting_account.uuid)));
    return okZone ? z : notFound('zone DNS');
  };
  // Nhà cung cấp DNS (Prompt 5.5): demo có sẵn một tài khoản Cloudflare; token không bao giờ trả về.
  const providersOf = (db: DemoDb): S['DnsProvider'][] => {
    let rows = providerStore.get(db);
    if (!rows) {
      const first: S['DnsProvider'] = {
        uuid: db.newUuid(),
        type: 'cloudflare',
        name: 'Cloudflare ITSO',
        zones_count: 0,
        account_label: 'ops@itso.vn',
        created_at: db.now(),
        updated_at: db.now(),
      };
      rows = [first];
      providerStore.set(db, rows);
      for (const z of db.data.dns_zones)
        if (z.provider === 'cloudflare') zoneProvider.set(z.uuid, first.uuid);
    }
    for (const p of rows)
      p.zones_count = db.data.dns_zones.filter((z) => zoneProvider.get(z.uuid) === p.uuid).length;
    return rows;
  };
  const superOnly = (ctx: Ctx) =>
    ctx.actor.role === 'SUPER_ADMIN'
      ? null
      : problem(403, 'forbidden', 'Không có quyền', 'Chỉ Super Admin quản lý nhà cung cấp DNS.');
  on(
    'get',
    P('/dns/providers'),
    (ctx) => superOnly(ctx) ?? page(ctx, providersOf(ctx.db), { search: ['name'] }),
  );
  on('post', P('/dns/providers'), (ctx) => {
    const deny = superOnly(ctx);
    if (deny) return deny;
    const b = (ctx.body ?? {}) as Partial<S['DnsProviderCreate']>;
    if (!b.name?.trim()) return invalid('Nhập tên nhà cung cấp.');
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(b.api_token ?? ''))
      return problem(
        422,
        'validation_failed',
        'Dữ liệu không hợp lệ',
        'Cloudflare từ chối token: Invalid API Token',
      );
    const row: S['DnsProvider'] = {
      uuid: ctx.db.newUuid(),
      type: 'cloudflare',
      name: b.name.trim(),
      zones_count: 0,
      account_label: 'demo@cloudflare',
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    };
    providersOf(ctx.db).push(row);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'dns.provider.create',
      resource: null,
      changes: { name: row.name },
    });
    return created(row);
  });
  on('delete', P('/dns/providers/{id}'), (ctx) => {
    const deny = superOnly(ctx);
    if (deny) return deny;
    const rows = providersOf(ctx.db);
    const p = rows.find((x) => x.uuid === ctx.params.id);
    if (!p) return notFound('nhà cung cấp DNS');
    if (p.zones_count > 0)
      return problem(
        409,
        'resource_locked',
        'Provider còn zone',
        'Gỡ các zone của provider trước.',
      );
    rows.splice(rows.indexOf(p), 1);
    return noContent();
  });
  on('post', P('/dns/zones'), (ctx) => {
    const b = (ctx.body ?? {}) as Partial<S['DnsZoneCreate']>;
    const p = providersOf(ctx.db).find((x) => x.uuid === b.provider_uuid);
    if (!p) return invalid('Chọn nhà cung cấp DNS.');
    const name = String(b.name ?? '').toLowerCase();
    if (!DOMAIN.test(name)) return invalid('Tên zone không hợp lệ.');
    const v = visibility(ctx.db, ctx.actor);
    const acc = b.hosting_account_uuid
      ? ctx.db.data.accounts.find((a) => a.uuid === b.hosting_account_uuid)
      : undefined;
    if (b.hosting_account_uuid && (!acc || !canSeeAccount(v, acc.uuid)))
      return invalid('Tài khoản hosting không hợp lệ.');
    if (!acc && !v.all) return invalid('ADMIN chỉ thêm zone gắn với account trong phạm vi.');
    if (ctx.db.data.dns_zones.some((z) => z.name === name))
      return problem(409, 'conflict', 'Xung đột', `Zone ${name} đã có.`);
    if (name.endsWith('.invalid') || name.startsWith('khong-co.'))
      return invalid(`Zone ${name} không có trong tài khoản Cloudflare của provider.`);
    const z: S['DnsZone'] = {
      uuid: ctx.db.newUuid(),
      name,
      provider: 'cloudflare',
      hosting_account: acc ? { uuid: acc.uuid, username: acc.username } : null,
      records_count: 0,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    };
    ctx.db.data.dns_zones.push(z);
    zoneProvider.set(z.uuid, p.uuid);
    z.records_count = recordsOf(ctx.db, z).length;
    return created(z);
  });
  on('patch', P('/dns/zones/{id}'), (ctx) => {
    const z = zoneOf(ctx);
    if (isReply(z)) return z;
    const b = (ctx.body ?? {}) as Partial<S['DnsZoneUpdate']>;
    const v = visibility(ctx.db, ctx.actor);
    const acc = b.hosting_account_uuid
      ? ctx.db.data.accounts.find((a) => a.uuid === b.hosting_account_uuid)
      : undefined;
    if (b.hosting_account_uuid && (!acc || !canSeeAccount(v, acc.uuid)))
      return invalid('Tài khoản hosting không hợp lệ.');
    if (!acc && !v.all) return invalid('ADMIN không bỏ gắn account khỏi zone.');
    z.hosting_account = acc ? { uuid: acc.uuid, username: acc.username } : null;
    z.updated_at = ctx.db.now();
    return ok(z);
  });
  on('delete', P('/dns/zones/{id}'), (ctx) => {
    const z = zoneOf(ctx);
    if (isReply(z)) return z;
    ctx.db.data.dns_zones = ctx.db.data.dns_zones.filter((x) => x.uuid !== z.uuid);
    zoneProvider.delete(z.uuid);
    return noContent();
  });
  on('post', P('/dns/zones/{id}:sync'), (ctx) => {
    const z = zoneOf(ctx);
    if (isReply(z)) return z;
    z.records_count = recordsOf(ctx.db, z).length;
    z.updated_at = ctx.db.now();
    return ok(z);
  });
  on('get', P('/dns/zones/{id}/records'), (ctx) => {
    const z = zoneOf(ctx);
    return isReply(z)
      ? z
      : page(ctx, recordsOf(ctx.db, z), { search: ['name', 'content', 'type'] });
  });
  const recordJob = (
    ctx: Ctx,
    z: S['DnsZone'],
    type: string,
    onDone: (rows: S['DnsRecord'][]) => void,
    changes: Record<string, unknown>,
  ) =>
    startJob(ctx, {
      type,
      resource: { type: 'dns_zone', uuid: z.uuid },
      ops: ['dns.records.apply'],
      server: null,
      changes,
      onDone: (db) => {
        const rows = recordsOf(db, z);
        onDone(rows);
        z.records_count = rows.length;
        z.updated_at = db.now();
      },
    });
  on('post', P('/dns/zones/{id}/records'), (ctx) => {
    const z = zoneOf(ctx);
    if (isReply(z)) return z;
    const b = (ctx.body ?? {}) as S['DnsRecordInput'];
    const err = recordError(b, z);
    if (err) return invalid(err);
    const rows = recordsOf(ctx.db, z);
    if (b.type === 'CNAME' && rows.some((r) => r.name === b.name))
      return problem(409, 'conflict', 'CNAME không được trùng tên với record khác');
    if (rows.some((r) => r.type === 'CNAME' && r.name === b.name))
      return problem(409, 'conflict', 'Tên này đã có CNAME');
    const rec = { uuid: ctx.db.newUuid(), ...b, proxied: b.proxied ?? false } as S['DnsRecord'];
    return recordJob(ctx, z, 'dns.record.create', (r) => r.push(rec), { ...b });
  });
  on('patch', P('/dns/zones/{id}/records/{record}'), (ctx) => {
    const z = zoneOf(ctx);
    if (isReply(z)) return z;
    const rec = recordsOf(ctx.db, z).find((r) => r.uuid === ctx.params.record);
    if (!rec) return notFound('record');
    const b = (ctx.body ?? {}) as Partial<S['DnsRecordInput']>;
    const next = { ...rec, ...b };
    const err = recordError(next, z);
    if (err) return invalid(err);
    return recordJob(ctx, z, 'dns.record.update', () => Object.assign(rec, b), {
      record: rec.uuid,
      ...b,
    });
  });
  on('delete', P('/dns/zones/{id}/records/{record}'), (ctx) => {
    const z = zoneOf(ctx);
    if (isReply(z)) return z;
    const rows = recordsOf(ctx.db, z);
    const rec = rows.find((r) => r.uuid === ctx.params.record);
    if (!rec) return notFound('record');
    if (rec.type === 'NS' && rec.name === '@')
      return problem(409, 'conflict', 'Không xóa record NS ở gốc zone');
    return recordJob(ctx, z, 'dns.record.delete', (r) => r.splice(r.indexOf(rec), 1), {
      record: rec.uuid,
      name: rec.name,
      type: rec.type,
    });
  });

  // ============================================================ cron
  const cronError = (
    db: DemoDb,
    a: Account,
    schedule?: string,
    command?: string,
    dir?: string,
  ): string | Reply | null => {
    if (schedule !== undefined) {
      if (!parseCron(schedule).ok)
        return 'Biểu thức cron không hợp lệ (5 trường: phút giờ ngày tháng thứ).';
      const L = limitsOf(db, a);
      const min = minInterval(schedule);
      if (L && min !== null && min < L.cron_min_interval_min)
        return limit(`Gói yêu cầu cron chạy cách nhau ít nhất ${L.cron_min_interval_min} phút.`);
    }
    if (
      command !== undefined &&
      (!command.trim() || /[\r\n\0]/.test(command) || command.length > 1024)
    )
      return 'Lệnh một dòng, 1–1024 ký tự.';
    if (dir !== undefined && normalizePath(dir, a.home_path) === null)
      return 'Thư mục làm việc phải nằm trong home.';
    return null;
  };
  on('post', P('/cron-jobs'), (ctx) => {
    const b = (ctx.body ?? {}) as Partial<S['CronJobCreate']>;
    const a = accountById(ctx, b.hosting_account_uuid);
    if (isReply(a)) return a;
    const e = cronError(ctx.db, a, b.schedule ?? '', b.command ?? '', b.working_dir);
    if (e) return typeof e === 'string' ? invalid(e) : e;
    const L = limitsOf(ctx.db, a);
    const used = ctx.db.data.cron.filter((c) => c.hosting_account.uuid === a.uuid).length;
    if (L && used >= L.cron_limit)
      return quota('cron_jobs', `Đã dùng ${L.cron_limit}/${L.cron_limit} cron_jobs theo gói.`);
    const site = b.website_uuid
      ? ctx.db.data.websites.find(
          (w) => w.uuid === b.website_uuid && w.hosting_account.uuid === a.uuid,
        )
      : undefined;
    if (b.website_uuid && !site) return invalid('Website không thuộc tài khoản này.');
    if (b.php_version && L && !L.php_versions.includes(b.php_version))
      return limit(`Gói chỉ cho phép PHP ${L.php_versions.join(', ')}.`);
    const c: S['CronJob'] = {
      uuid: ctx.db.newUuid(),
      hosting_account: accRef(a),
      website: site ? siteRef(site) : null,
      schedule: (b.schedule as string).trim(),
      command: (b.command as string).trim(),
      working_dir: normalizePath(b.working_dir ?? '.', a.home_path) ?? '.',
      php_version: b.php_version ?? null,
      enabled: b.enabled ?? true,
      timeout_sec: b.timeout_sec ?? 3600,
      last_run_at: null,
      last_status: null,
      ...fresh(ctx.db),
    };
    ctx.db.data.cron.push(c);
    a.usage.cron_jobs.used += 1;
    return startJob(ctx, {
      type: 'cron.create',
      resource: { type: 'cron_job', uuid: c.uuid },
      ops: ['cron.apply'],
      server: a.server,
      changes: { schedule: c.schedule, command: c.command },
      onDone: (db) => applied(c, db),
    });
  });
  const cronOf = (ctx: Ctx) => owned(ctx, ctx.db.data.cron, 'cron job');
  on('patch', P('/cron-jobs/{id}'), (ctx) => {
    const c = cronOf(ctx);
    if (isReply(c)) return c;
    const a = ctx.db.data.accounts.find((x) => x.uuid === c.hosting_account.uuid) as Account;
    const b = (ctx.body ?? {}) as S['CronJobUpdate'];
    const e = cronError(ctx.db, a, b.schedule, b.command, b.working_dir);
    if (e) return typeof e === 'string' ? invalid(e) : e;
    bump(c, ctx.db);
    c.status = 'provisioning';
    return startJob(ctx, {
      type: 'cron.update',
      resource: { type: 'cron_job', uuid: c.uuid },
      ops: ['cron.apply'],
      server: a.server,
      changes: b as Record<string, unknown>,
      onDone: (db) => {
        Object.assign(c, b);
        applied(c, db);
      },
    });
  });
  on('delete', P('/cron-jobs/{id}'), (ctx) => {
    const c = cronOf(ctx);
    if (isReply(c)) return c;
    const a = ctx.db.data.accounts.find((x) => x.uuid === c.hosting_account.uuid);
    c.status = 'deleting';
    return startJob(ctx, {
      type: 'cron.delete',
      resource: { type: 'cron_job', uuid: c.uuid },
      ops: ['cron.apply'],
      server: a?.server ?? null,
      onDone: (db) => {
        db.data.cron = db.data.cron.filter((x) => x.uuid !== c.uuid);
        if (a) a.usage.cron_jobs.used = Math.max(0, a.usage.cron_jobs.used - 1);
      },
    });
  });
  on('get', P('/cron-jobs/{id}/runs'), (ctx) => {
    const c = cronOf(ctx);
    return isReply(c) ? c : page(ctx, runsOf(ctx.db, c));
  });
  on('post', P('/cron-jobs/{id}:run'), (ctx) => {
    const c = cronOf(ctx);
    if (isReply(c)) return c;
    const a = ctx.db.data.accounts.find((x) => x.uuid === c.hosting_account.uuid);
    return startJob(ctx, {
      type: 'cron.run',
      resource: { type: 'cron_job', uuid: c.uuid },
      ops: ['cron.run_once'],
      server: a?.server ?? null,
      onDone: (db) => {
        const now = db.now();
        runsOf(db, c).unshift({
          uuid: db.newUuid(),
          started_at: now,
          finished_at: now,
          exit_code: 0,
          status: 'succeeded',
          output_tail: `$ ${c.command}\nĐã chạy xong (thủ công).`,
        });
        c.last_run_at = now;
        c.last_status = 'succeeded';
      },
    });
  });

  // ============================================================ WordPress
  const wps = (db: DemoDb) => db.data.wordpress as S['WordPressSite'][];
  on('post', P('/wordpress/sites'), (ctx) => {
    const b = (ctx.body ?? {}) as Partial<S['WordPressInstall']>;
    const w = ctx.db.data.websites.find((x) => x.uuid === b.website_uuid);
    const v = visibility(ctx.db, ctx.actor);
    if (!w || !canSeeAccount(v, w.hosting_account.uuid))
      return invalid('Chọn website trong phạm vi của bạn.');
    if (w.type !== 'php') return invalid('WordPress cần website loại PHP.');
    if (wps(ctx.db).some((x) => x.website.uuid === w.uuid))
      return problem(409, 'conflict', 'Website đã cài WordPress');
    if (!b.title?.trim() || b.title.length > 120)
      return invalid('Nhập tiêu đề site (≤ 120 ký tự).');
    if (
      !b.admin_username ||
      !/^[a-z][a-z0-9_]{2,30}$/.test(b.admin_username) ||
      b.admin_username === 'admin'
    )
      return invalid('Tên quản trị 3–31 ký tự, không dùng "admin".');
    if (!b.admin_email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.admin_email))
      return invalid('Email không hợp lệ.');
    const a = accountOfSite(ctx.db, w);
    const L = limitsOf(ctx.db, a);
    const dbs = ctx.db.data.databases.filter((d) => d.hosting_account.uuid === a.uuid).length;
    if (L && dbs >= L.database_limit)
      return quota('databases', 'Cài WordPress cần thêm 1 database nhưng gói đã hết hạn mức.');
    return startJob(ctx, {
      type: 'wordpress.install',
      resource: { type: 'website', uuid: w.uuid },
      ops: ['db.mysql.create', 'wp.install', 'wp.harden'],
      server: w.server,
      changes: { title: b.title, admin: b.admin_username, locale: b.locale },
      onDone: (db) => {
        wps(db).push({
          uuid: db.newUuid(),
          website: siteRef(w),
          hosting_account: accRef(a),
          wp_version: '6.7.1',
          latest_version: '6.7.1',
          plugins_total: 2,
          plugins_outdated: 0,
          themes_outdated: 0,
          auto_update: 'minor',
          hardening: { xmlrpc_disabled: true, file_edit_disabled: true, login_rate_limit: true },
          staging_of: null,
          updated_at: db.now(),
        });
        const name = `${a.username}_wp${String(db.data.databases.length).slice(-2)}`;
        db.data.databases.push({
          uuid: db.newUuid(),
          hosting_account: accRef(a),
          server: a.server,
          engine: 'mariadb',
          name,
          size_mb: 4.2,
          charset: 'utf8mb4',
          users: [name],
          ...fresh(db),
          status: 'ready',
          observed_version: 1,
          observed_at: db.now(),
        });
        a.usage.databases.used += 1;
      },
    });
  });
  const wpOf = (ctx: Ctx) => owned(ctx, wps(ctx.db), 'site WordPress');
  for (const [action, ops] of [
    ['update', ['backup.run', 'wp.update']],
    ['clone-staging', ['wp.clone']],
    ['harden', ['wp.harden']],
  ] as const) {
    on('post', P(`/wordpress/sites/{id}:${action}`), (ctx) => {
      const wp = wpOf(ctx);
      if (isReply(wp)) return wp;
      const w = ctx.db.data.websites.find((x) => x.uuid === wp.website.uuid) as Website;
      const a = accountOfSite(ctx.db, w);
      if (
        action === 'update' &&
        wp.wp_version === wp.latest_version &&
        wp.plugins_outdated === 0 &&
        wp.themes_outdated === 0
      ) {
        return problem(409, 'conflict', 'WordPress, plugin và theme đều đã mới nhất');
      }
      if (action === 'clone-staging') {
        if (wp.staging_of) return problem(409, 'conflict', 'Đây đã là bản staging');
        const staging = `staging.${w.primary_domain}`;
        if (ctx.db.data.websites.some((x) => x.primary_domain === staging))
          return problem(409, 'conflict', 'Bản staging đã tồn tại');
        const L = limitsOf(ctx.db, a);
        if (
          L &&
          ctx.db.data.websites.filter((x) => x.hosting_account.uuid === a.uuid).length >=
            L.website_limit
        )
          return quota('websites', 'Tạo staging cần thêm 1 website nhưng gói đã hết hạn mức.');
      }
      return startJob(ctx, {
        type: `wordpress.${action.replace('-', '_')}`,
        resource: { type: 'wordpress_site', uuid: wp.uuid },
        ops: [...ops],
        server: w.server,
        onDone: (db) => {
          wp.updated_at = db.now();
          if (action === 'update') {
            wp.wp_version = wp.latest_version;
            wp.plugins_outdated = 0;
            wp.themes_outdated = 0;
          } else if (action === 'harden') {
            wp.hardening = {
              ...wp.hardening,
              xmlrpc_disabled: true,
              file_edit_disabled: true,
              login_rate_limit: true,
              uploads_no_php: true,
            };
          } else {
            const site: Website = {
              ...structuredClone(w),
              uuid: db.newUuid(),
              primary_domain: `staging.${w.primary_domain}`,
              domains_count: 1,
              waf_enabled: false,
              ssl_mode: 'acme',
              created_at: db.now(),
              updated_at: db.now(),
            };
            db.data.websites.push(site);
            a.usage.websites.used += 1;
            wps(db).push({
              ...structuredClone(wp),
              uuid: db.newUuid(),
              website: siteRef(site),
              staging_of: wp.uuid,
              auto_update: 'off',
              updated_at: db.now(),
            });
          }
        },
      });
    });
  }

  // ============================================================ Git deploy
  const repos = (db: DemoDb) => db.data.git_repositories as GitRepo[];
  const deploys = (db: DemoDb) => db.data.git_deployments as GitDeploy[];
  const repoOf = (ctx: Ctx, id = ctx.params.id) => owned(ctx, repos(ctx.db), 'repository', id);
  on('get', P('/git-repositories/{id}/deployments'), (ctx) => {
    const r = repoOf(ctx);
    if (isReply(r)) return r;
    return page(
      ctx,
      deploys(ctx.db).filter((d) => d.repository_uuid === r.uuid),
      { sort: '-created_at' },
    );
  });
  on('post', P('/git-repositories'), (ctx) => {
    const b = (ctx.body ?? {}) as Partial<S['GitRepositoryCreate']>;
    const w = ctx.db.data.websites.find((x) => x.uuid === b.website_uuid);
    const v = visibility(ctx.db, ctx.actor);
    if (!w || !canSeeAccount(v, w.hosting_account.uuid))
      return invalid('Chọn website trong phạm vi của bạn.');
    if (repos(ctx.db).some((r) => r.website.uuid === w.uuid))
      return problem(409, 'conflict', 'Website đã kết nối repository');
    if (!b.repo_url || !/^(ssh:\/\/\S+|git@[^\s:]+:\S+|https:\/\/\S+)$/.test(b.repo_url))
      return invalid('URL repository dạng git@host:owner/repo.git, ssh:// hoặc https://.');
    if (!b.branch || !/^[A-Za-z0-9._/-]+$/.test(b.branch))
      return invalid('Tên branch không hợp lệ.');
    if (b.build_command && /[\r\n\0]/.test(b.build_command)) return invalid('Lệnh build một dòng.');
    for (const p of b.shared_paths ?? [])
      if (normalizePath(p) === null)
        return invalid('Đường dẫn dùng chung phải nằm trong thư mục site.');
    const a = accountOfSite(ctx.db, w);
    const tok = Math.random().toString(16).slice(2, 12);
    const r: GitRepo = {
      uuid: ctx.db.newUuid(),
      website: siteRef(w),
      hosting_account: accRef(a),
      repo_url: b.repo_url,
      branch: b.branch,
      deploy_key_public: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${tok.toUpperCase()}${tok} itso-deploy-${w.primary_domain}`,
      deploy_key_fingerprint: `SHA256:${btoa(tok + w.primary_domain)
        .replace(/=+$/, '')
        .slice(0, 43)}`,
      webhook_url: `https://panel.itso.local/api/v1/hooks/git/gh_${tok}`,
      auto_deploy: b.auto_deploy ?? false,
      build_command: b.build_command ?? null,
      shared_paths: b.shared_paths ?? [],
      keep_releases: b.keep_releases ?? 5,
      current_deployment: null,
      ...fresh(ctx.db),
      status: 'ready',
    };
    repos(ctx.db).push(r);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'git.connect',
      resource: { type: 'git_repository', uuid: r.uuid },
      server: w.server,
      changes: { repo_url: r.repo_url, branch: r.branch },
    });
    return created(r);
  });
  on('patch', P('/git-repositories/{id}'), (ctx) => {
    const r = repoOf(ctx);
    if (isReply(r)) return r;
    const b = (ctx.body ?? {}) as S['GitRepositoryUpdate'];
    if (b.branch !== undefined && !/^[A-Za-z0-9._/-]+$/.test(b.branch))
      return invalid('Tên branch không hợp lệ.');
    if (b.keep_releases !== undefined && (b.keep_releases < 1 || b.keep_releases > 20))
      return invalid('Giữ 1–20 release.');
    if (b.build_command && /[\r\n\0]/.test(b.build_command)) return invalid('Lệnh build một dòng.');
    Object.assign(r, b);
    r.updated_at = ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'git.update',
      resource: { type: 'git_repository', uuid: r.uuid },
      changes: b as Record<string, unknown>,
    });
    return ok(r);
  });
  on('delete', P('/git-repositories/{id}'), (ctx) => {
    const r = repoOf(ctx);
    if (isReply(r)) return r;
    ctx.db.data.git_repositories = repos(ctx.db).filter((x) => x.uuid !== r.uuid);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'git.disconnect',
      resource: { type: 'git_repository', uuid: r.uuid },
    });
    return noContent();
  });
  on('post', P('/git-repositories/{id}:rotate-webhook-secret'), (ctx) => {
    const r = repoOf(ctx);
    if (isReply(r)) return r;
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'git.rotate_webhook_secret',
      resource: { type: 'git_repository', uuid: r.uuid },
    });
    return ok({ secret: `whsec_${secret(24).replace(/[^A-Za-z0-9]/g, 'x')}` });
  });
  const deploy = (
    ctx: Ctx,
    r: GitRepo,
    commit: string,
    trigger: GitDeploy['trigger'],
    msg: string | null,
    rollbackOf: GitDeploy | null,
  ) => {
    const w = ctx.db.data.websites.find((x) => x.uuid === r.website.uuid);
    if (
      deploys(ctx.db).some(
        (d) => d.repository_uuid === r.uuid && (d.state === 'queued' || d.state === 'running'),
      )
    ) {
      return problem(409, 'resource_locked', 'Đang có lần deploy chạy cho repository này');
    }
    const now = ctx.db.now();
    const d: GitDeploy = {
      uuid: ctx.db.newUuid(),
      repository_uuid: r.uuid,
      commit_sha: commit,
      commit_message: msg,
      commit_author: rollbackOf ? rollbackOf.commit_author : 'Nguyễn Văn Bảo',
      trigger,
      state: 'running',
      release_path: rollbackOf
        ? rollbackOf.release_path
        : `sites/${r.website.primary_domain}/releases/20261120${now.slice(11, 13)}${now.slice(14, 16)}${now.slice(17, 19)}`,
      rollback_of: rollbackOf?.uuid ?? null,
      job_uuid: null,
      requested_by: actorRef(ctx),
      started_at: now,
      finished_at: null,
      created_at: now,
    };
    deploys(ctx.db).push(d);
    const reply = startJob(ctx, {
      type: rollbackOf ? 'git.rollback' : 'git.deploy',
      resource: { type: 'git_repository', uuid: r.uuid },
      ops: rollbackOf ? ['git.rollback', 'php.pool.apply'] : ['git.deploy', 'php.pool.apply'],
      server: w?.server ?? null,
      changes: { commit, branch: r.branch },
      onDone: (db) => {
        d.state = 'succeeded';
        d.finished_at = db.now();
        r.current_deployment = {
          uuid: d.uuid,
          commit_sha: d.commit_sha,
          finished_at: d.finished_at,
        };
        if (rollbackOf) {
          for (const x of deploys(db))
            if (
              x.repository_uuid === r.uuid &&
              x.created_at > rollbackOf.created_at &&
              x.uuid !== d.uuid &&
              x.state === 'succeeded'
            )
              x.state = 'rolled_back';
        }
      },
    });
    d.job_uuid = (reply.body as { job: { uuid: string } }).job.uuid;
    return reply;
  };
  on('post', P('/git-repositories/{id}/deployments'), (ctx) => {
    const r = repoOf(ctx);
    if (isReply(r)) return r;
    const want = (ctx.body as { commit_sha?: string | null } | undefined)?.commit_sha ?? null;
    if (want !== null && !/^[0-9a-f]{7,40}$/.test(want))
      return invalid('Mã commit 7–40 ký tự hex.');
    return deploy(
      ctx,
      r,
      want ?? sha(),
      'manual',
      want ? null : `Commit mới nhất trên ${r.branch}`,
      null,
    );
  });
  on('post', P('/git-deployments/{id}:rollback'), (ctx) => {
    const d = deploys(ctx.db).find((x) => x.uuid === ctx.params.id);
    if (!d) return notFound('lần deploy');
    const r = repoOf(ctx, d.repository_uuid);
    if (isReply(r)) return r;
    if (d.state !== 'succeeded' && d.state !== 'rolled_back')
      return problem(409, 'conflict', 'Chỉ quay về release đã deploy thành công');
    if (r.current_deployment?.uuid === d.uuid)
      return problem(409, 'conflict', 'Release này đang chạy');
    const kept = deploys(ctx.db)
      .filter((x) => x.repository_uuid === r.uuid && x.trigger !== 'rollback')
      .sort((x, y) => y.created_at.localeCompare(x.created_at))
      .slice(0, r.keep_releases);
    if (!kept.some((x) => x.uuid === d.uuid))
      return problem(409, 'conflict', 'Release đã bị dọn (ngoài số release được giữ)');
    return deploy(ctx, r, d.commit_sha, 'rollback', `Quay về ${d.commit_sha}`, d);
  });
}
