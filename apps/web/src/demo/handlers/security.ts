import type { components as A } from '@/api/generated/admin/schema';
import { powValid } from '@/shared/auth/pow';
import { onTick, type DemoDb } from '../db';
import { isReply } from '../list';
import { ok, on, problem, type ApiPath, type Ctx } from '../router';
import { canSeeAccount, canSeeServer, visibility } from '../scope';
import { registerListSpecs } from './admin';
import { startJob } from './writes';

/**
 * Prompt 7.0 (mockup Phase 7): CAPTCHA proof-of-work, SSH safe-apply có xác nhận, policy + phiên terminal,
 * file nghi nhiễm (Admin + Portal), baseline FIM. Hành vi theo OpenAPI và D-76…D-81.
 */
type S = A['schemas'];
type Finding = S['MalwareFinding'];
const AP = (p: string) => `/api/v1/admin${p}` as ApiPath;
const PP = (p: string) => `/api/v1/portal${p}` as ApiPath;
const saOnly = (ctx: Ctx) =>
  ctx.actor.role === 'SUPER_ADMIN' ? null : problem(403, 'forbidden', 'Chỉ Super Admin');

const without = <T>(o: Record<string, T>, k: string): Record<string, T> =>
  Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));

// ---------------------------------------------------------------- CAPTCHA (D-81)
/** Độ khó demo: 12 bit (~4 nghìn lần băm) để giải nhanh trên trình duyệt. */
export const DEMO_CAPTCHA_DIFFICULTY = 12;
/** Mật khẩu này coi là sai ở bản demo (để thử khóa lũy tiến + CAPTCHA). */
export const DEMO_WRONG_PASSWORD = 'wrong-password';

interface CaptchaState {
  issued: Record<string, number>;
  failures: Record<string, number>;
}
function captchaState(db: DemoDb): CaptchaState {
  db.data.captcha_state ??= { issued: {}, failures: {} } satisfies CaptchaState;
  return db.data.captcha_state as CaptchaState;
}
const threshold = (db: DemoDb) =>
  Number(
    (db.data.settings as { security?: { portal_captcha_after_failures?: number } }).security
      ?.portal_captcha_after_failures ?? 3,
  );

/** Kiểm đăng nhập demo: trả lỗi (422) hoặc null nếu cho qua. Dùng trong handler login. */
export async function checkLogin(
  ctx: Ctx,
  body: {
    email: string;
    password: string;
    captcha?: { challenge?: string; nonce?: string } | undefined;
  },
) {
  const st = captchaState(ctx.db);
  const key = body.email.trim().toLowerCase();
  const fails = st.failures[key] ?? 0;
  if (fails >= threshold(ctx.db)) {
    const c = body.captcha;
    const exp = c?.challenge ? st.issued[c.challenge] : undefined;
    const good =
      c?.challenge !== undefined &&
      c.nonce !== undefined &&
      exp !== undefined &&
      exp > Date.now() &&
      (await powValid(c.challenge, c.nonce, DEMO_CAPTCHA_DIFFICULTY));
    if (c?.challenge) st.issued = without(st.issued, c.challenge); // dùng một lần
    if (!good) {
      return problem(
        422,
        'captcha_required',
        'Cần xác minh CAPTCHA',
        'Đã đăng nhập sai nhiều lần; trình duyệt cần giải CAPTCHA trước khi thử lại.',
      );
    }
  }
  if (body.password === DEMO_WRONG_PASSWORD) {
    st.failures[key] = fails + 1;
    const r = problem(
      422,
      'validation_failed',
      'Dữ liệu không hợp lệ',
      'Email hoặc mật khẩu không đúng.',
    );
    return {
      ...r,
      body: { ...(r.body as object), errors: { email: ['Email hoặc mật khẩu không đúng.'] } },
    };
  }
  st.failures = without(st.failures, key);
  return null;
}

// ---------------------------------------------------------------- SSH safe-apply (D-77)
interface SshState {
  previous: S['SshSettings'] | null;
  deadline: number | null;
}
export function sshState(db: DemoDb): SshState {
  db.data.ssh_state ??= { previous: null, deadline: null } satisfies SshState;
  return db.data.ssh_state as SshState;
}

function serverHn(db: DemoDb) {
  const s = db.data.servers[0];
  return s ? { uuid: s.uuid, name: s.name } : null;
}

export function registerSecurity() {
  on('get', '/api/v1/auth/captcha', (ctx) => {
    const st = captchaState(ctx.db);
    const exp = Date.now() + 5 * 60_000;
    const challenge = `v1.${Math.floor(Date.now() / 1000)}.${ctx.db.newUuid().replace(/-/g, '').slice(-16)}`;
    st.issued[challenge] = exp;
    return ok({
      challenge,
      difficulty: DEMO_CAPTCHA_DIFFICULTY,
      expires_at: new Date(exp + 7 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '+07:00'),
    });
  });

  // SSH hết hạn xác nhận → khôi phục cấu hình trước.
  onTick((db) => {
    const st = db.data.ssh_state as SshState | undefined;
    if (st?.deadline && Date.now() > st.deadline) {
      st.deadline = null;
      if (st.previous) db.data.ssh_settings = st.previous;
      st.previous = null;
      const s = serverHn(db);
      db.audit({
        actor: { uuid: s?.uuid ?? '', name: 'itso-agent', email: 'agent@itso.local' },
        action: 'sshd.rollback',
        resource: { type: 'server', uuid: s?.uuid ?? '' },
        server: s,
      });
    }
  });
  on('post', AP('/security/ssh:confirm'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const st = sshState(ctx.db);
    if (!st.deadline) {
      return problem(409, 'conflict', 'Không có thay đổi SSH nào đang chờ xác nhận (đã hoàn tác?)');
    }
    st.deadline = null;
    st.previous = null;
    const s = serverHn(ctx.db);
    return startJob(ctx, {
      type: 'sshd.confirm',
      resource: { type: 'server', uuid: s?.uuid ?? '' },
      ops: ['sshd.config.confirm'],
      server: s,
    });
  });

  // ---------------------------------------------------------------- FIM
  on('post', AP('/servers/{id}/fim:baseline'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const s = ctx.db.data.servers.find((x) => x.uuid === ctx.params.id);
    if (!s) return problem(404, 'not_found', 'Không tìm thấy server');
    return startJob(ctx, {
      type: 'fim.baseline',
      resource: { type: 'server', uuid: s.uuid },
      ops: ['fim.baseline'],
      server: { uuid: s.uuid, name: s.name },
      onDone: (db) => {
        for (const e of db.data.security_events as S['SecurityEvent'][]) {
          if (e.type === 'fim.change' && e.server.uuid === s.uuid && !e.acknowledged_at) {
            e.acknowledged_at = db.now();
          }
        }
      },
    });
  });

  // ---------------------------------------------------------------- terminal (D-81)
  on('get', AP('/servers/{id}/terminal/policy'), (ctx) => {
    const v = visibility(ctx.db, ctx.actor);
    const s = ctx.db.data.servers.find((x) => x.uuid === ctx.params.id);
    if (!s || !canSeeServer(v, s.uuid)) return problem(404, 'not_found', 'Không tìm thấy server');
    return ok({
      ...(ctx.db.data.terminal_policy as S['TerminalPolicy']),
      server: { uuid: s.uuid, name: s.name },
    });
  });
  registerListSpecs([
    {
      path: AP('/terminal/sessions'),
      rows: (db) => db.data.terminal_sessions as never,
      scope: 'server',
      search: ['unix_user', 'client_ip'],
      sort: '-started_at',
    },
  ]);
  on('get', AP('/terminal/sessions/{id}/recording'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const t = (ctx.db.data.terminal_sessions as S['TerminalSession'][]).find(
      (x) => x.uuid === ctx.params.id,
    );
    if (!t) return problem(404, 'not_found', 'Không tìm thấy phiên');
    if (!t.recorded) return problem(404, 'not_found', 'Phiên này không được ghi');
    return ok({
      ...(ctx.db.data.terminal_recording as S['TerminalRecording']),
      session_uuid: t.uuid,
    });
  });

  // ---------------------------------------------------------------- mã độc (D-79)
  const findings = (db: DemoDb) => db.data.malware_findings as Finding[];
  registerListSpecs([
    {
      path: AP('/security/malware/findings'),
      rows: (db) => findings(db) as never,
      scope: 'account',
      search: ['path', 'signature'],
      filters: { hosting_account: 'hosting_account.uuid' },
      sort: '-found_at',
    },
    {
      path: PP('/protection/findings'),
      rows: (db) => findings(db) as never,
      scope: 'account',
      search: ['path', 'signature'],
      filters: { hosting_account: 'hosting_account.uuid' },
      sort: '-found_at',
    },
  ]);
  const findingOf = (ctx: Ctx): Finding | ReturnType<typeof problem> => {
    const v = visibility(ctx.db, ctx.actor);
    const f = findings(ctx.db).find((x) => x.uuid === ctx.params.id);
    return f && canSeeAccount(v, f.hosting_account.uuid)
      ? f
      : problem(404, 'not_found', 'Không tìm thấy file nghi nhiễm');
  };
  const serverOfAccount = (db: DemoDb, acc: string) => {
    const a = db.data.accounts.find((x) => x.uuid === acc);
    return a ? a.server : null;
  };
  const quarantine = (ctx: Ctx) => {
    const f = findingOf(ctx);
    if (isReply(f)) return f;
    if (f.action !== 'none') return problem(409, 'conflict', 'File đã được xử lý');
    return startJob(ctx, {
      type: 'malware.quarantine',
      resource: { type: 'hosting_account', uuid: f.hosting_account.uuid },
      ops: ['malware.quarantine'],
      server: serverOfAccount(ctx.db, f.hosting_account.uuid),
      onDone: (db) => {
        f.action = 'quarantined';
        (db.data.quarantine as S['QuarantineItem'][]).unshift({
          uuid: db.newUuid(),
          hosting_account: f.hosting_account,
          original_path: f.path,
          sha256: '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f',
          signature: f.signature,
          size: 68,
          quarantined_at: db.now(),
          restored_at: null,
        });
        const ov = db.data.security_overview as S['SecurityOverview'];
        ov.malware_findings_open = findings(db).filter((x) => x.action === 'none').length;
      },
    });
  };
  on('post', AP('/security/malware/findings/{id}:quarantine'), quarantine);
  on('post', PP('/protection/findings/{id}:quarantine'), quarantine);
  on('delete', PP('/protection/findings/{id}'), (ctx) => {
    const f = findingOf(ctx);
    if (isReply(f)) return f;
    if (f.action === 'deleted') return problem(409, 'conflict', 'File đã bị xóa');
    return startJob(ctx, {
      type: 'malware.delete',
      resource: { type: 'hosting_account', uuid: f.hosting_account.uuid },
      ops: ['malware.delete'],
      server: serverOfAccount(ctx.db, f.hosting_account.uuid),
      onDone: () => {
        f.action = 'deleted';
      },
    });
  });

  // ---------------------------------------------------------------- Portal: tổng quan bảo vệ + quét account
  on('get', PP('/protection'), (ctx) => {
    const v = visibility(ctx.db, ctx.actor);
    const accounts = ctx.db.data.accounts.filter((a) => canSeeAccount(v, a.uuid));
    const waf = ctx.db.data.waf as S['WafSettings'][] | S['WafSettings'];
    const wafRows = Array.isArray(waf) ? waf : [waf];
    return ok({
      accounts: accounts.map((a) => ({
        hosting_account: { uuid: a.uuid, username: a.username },
        websites: ctx.db.data.websites
          .filter((w) => w.hosting_account.uuid === a.uuid && w.type === 'php')
          .map((w) => {
            const ws = wafRows.find((x) => x.website.uuid === w.uuid);
            return {
              website: { uuid: w.uuid, primary_domain: w.primary_domain },
              waf_enabled: ws?.enabled ?? w.waf_enabled,
              waf_mode: ws?.mode ?? 'detect',
              blocked_24h: ws?.blocked_24h ?? 0,
            };
          }),
        findings_open: findings(ctx.db).filter(
          (f) => f.hosting_account.uuid === a.uuid && f.action === 'none',
        ).length,
        last_scan_at:
          (ctx.db.data.portal_scans as Record<string, string> | undefined)?.[a.uuid] ??
          (ctx.db.data.malware_scans as S['MalwareScan'][]).find(
            (s) => s.hosting_account.uuid === a.uuid,
          )?.finished_at ??
          null,
        scan_running: ctx.db.data.jobs.some(
          (j) =>
            j.type === 'malware.scan' &&
            j.resource?.uuid === a.uuid &&
            (j.state === 'queued' || j.state === 'running'),
        ),
      })),
    });
  });
  on('post', PP('/hosting-accounts/{id}/scans'), (ctx) => {
    const v = visibility(ctx.db, ctx.actor);
    const a = ctx.db.data.accounts.find((x) => x.uuid === ctx.params.id);
    if (!a || !canSeeAccount(v, a.uuid)) return problem(404, 'not_found', 'Không tìm thấy account');
    return startJob(ctx, {
      type: 'malware.scan',
      resource: { type: 'hosting_account', uuid: a.uuid },
      ops: ['malware.scan'],
      server: a.server,
      onDone: (db) => {
        db.data.portal_scans ??= {};
        (db.data.portal_scans as Record<string, string>)[a.uuid] = db.now();
      },
    });
  });
}
