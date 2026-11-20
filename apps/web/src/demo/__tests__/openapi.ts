// Bộ kiểm response theo OpenAPI (dùng trong test Node): nạp contracts/openapi/*.yaml vào Ajv 2020.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const DIR = resolve(import.meta.dirname, '../../../../../contracts/openapi');
const BASE = 'https://contracts.itso.local/openapi/';
const FILES = {
  admin: 'itso-admin-v1.yaml',
  portal: 'itso-portal-v1.yaml',
  common: 'common.yaml',
} as const;

type Doc = {
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
} & Record<string, unknown>;

const docs = Object.fromEntries(
  Object.entries(FILES).map(([k, f]) => [k, parse(readFileSync(resolve(DIR, f), 'utf8')) as Doc]),
) as Record<keyof typeof FILES, Doc>;

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
for (const f of Object.values(FILES)) {
  const key = Object.entries(FILES).find(([, v]) => v === f)?.[0] as keyof typeof FILES;
  ajv.addSchema({ ...docs[key], $id: BASE + f });
}

const ptr = (s: string) => s.replaceAll('~', '~0').replaceAll('/', '~1');

/** Tài liệu (admin/portal) chứa đường dẫn này. */
export function docFor(path: string): 'admin' | 'portal' {
  return path in docs.admin.paths ? 'admin' : 'portal';
}

export function declaredStatuses(path: string, method: string): string[] {
  const op = docs[docFor(path)].paths[path]?.[method];
  return op ? Object.keys(op.responses) : [];
}

export function hasOperation(path: string, method: string): boolean {
  return Boolean(docs.admin.paths[path]?.[method] ?? docs.portal.paths[path]?.[method]);
}

/** Validate body theo schema response (status) của operation; trả danh sách lỗi (rỗng = hợp lệ). */
export function validateResponse(
  path: string,
  method: string,
  status: number,
  body: unknown,
): string[] {
  const realm = docFor(path);
  const op = docs[realm].paths[path]?.[method];
  if (!op) return [`${method.toUpperCase()} ${path}: không có trong OpenAPI`];
  type Resp = { $ref?: string; content?: Record<string, { schema?: unknown }> };
  let file: string = FILES[realm];
  let pointer = `/paths/${ptr(path)}/${method}/responses/${op.responses[String(status)] ? status : 'default'}`;
  let resp = (op.responses[String(status)] ?? op.responses.default) as Resp | undefined;
  if (!resp)
    return [`${method.toUpperCase()} ${path}: status ${status} không khai báo trong OpenAPI`];
  // Response dùng chung: `./common.yaml#/components/responses/X`.
  if (resp.$ref) {
    const [f, frag = ''] = resp.$ref.split('#');
    file = f ? f.replace(/^\.\//, '') : file;
    pointer = frag;
    const key = (Object.entries(FILES).find(([, v]) => v === file)?.[0] ??
      realm) as keyof typeof FILES;
    resp = frag
      .split('/')
      .slice(1)
      .reduce<unknown>(
        (o, k) => (o as Record<string, unknown>)?.[k.replaceAll('~1', '/').replaceAll('~0', '~')],
        docs[key],
      ) as Resp | undefined;
    if (!resp) return [`không giải được ${String((op.responses[String(status)] as Resp).$ref)}`];
  }
  const mediaType = resp.content?.['application/json']
    ? 'application/json'
    : 'application/problem+json';
  const media = resp.content?.[mediaType];
  if (!media?.schema)
    return body === undefined || body === null ? [] : ['response không khai báo body'];
  const ref = `${BASE}${file}#${pointer}/content/${ptr(mediaType)}/schema`;
  const validate = ajv.getSchema(ref) ?? ajv.compile({ $ref: ref });
  if (validate(body)) return [];
  return (validate.errors ?? [])
    .slice(0, 5)
    .map((e) => `${e.instancePath || '/'} ${e.message ?? ''} ${JSON.stringify(e.params)}`);
}
