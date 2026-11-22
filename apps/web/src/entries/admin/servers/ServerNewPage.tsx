import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Loader2, ServerCog } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useFmt } from '@/shared/format/useFmt';
import { TextField } from '@/shared/page/fields';
import { InfoList } from '@/shared/page/InfoList';
import { PageHeader } from '@/shared/page/PageHeader';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { Button, buttonVariants } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Checkbox } from '@/ui/Checkbox';
import { CodeBlock } from '@/ui/CodeBlock';
import { FormField } from '@/ui/FormField';
import { list, send } from '../api';
import { useAction } from '../useAction';

const ROLES = ['web', 'db', 'backup', 'docker'] as const;
type Role = (typeof ROLES)[number];

export const enrollSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'admin:servers.errors.name'),
  role_tags: z.array(z.enum(ROLES)).min(1, 'admin:servers.errors.roles'),
  ttl_min: z
    .number()
    .int()
    .min(5, 'admin:servers.errors.ttl')
    .max(1440, 'admin:servers.errors.ttl'),
});
type Form = z.infer<typeof enrollSchema>;
interface Token {
  token: string;
  command: string;
  ca_sha256: string;
  expires_at: string;
}

/** Thêm server: tạo token đăng ký → chạy lệnh join trên máy mới → chờ agent kết nối. */
export default function ServerNewPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [token, setToken] = useState<(Token & { name: string }) | null>(null);
  const { control, handleSubmit } = useForm<Form>({
    resolver: zodResolver(enrollSchema),
    defaultValues: { name: '', role_tags: ['web'], ttl_min: 60 },
  });
  const create = useAction(
    (v: Form) => send<Token>('POST', '/api/v1/admin/servers/enrollment-tokens', { body: v }),
    { onSuccess: (r, v) => setToken({ ...r, name: v.name }) },
  );
  // Chờ agent kết nối: hỏi lại danh sách server theo tên mỗi 2 giây.
  const joined = useQuery({
    queryKey: ['admin', 'servers', 'join', token?.name],
    enabled: token !== null,
    queryFn: async () =>
      (await list('/api/v1/admin/servers', { q: token?.name ?? '', filters: {} })).find(
        (s) => s.name === token?.name,
      ) ?? null,
    refetchInterval: (q) => (q.state.data ? false : 2000),
  });

  return (
    <>
      <PageHeader title={t('servers.addTitle')} description={t('servers.addDescription')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('servers.step1')} />
          <CardContent>
            <form
              noValidate
              className="flex flex-col gap-4"
              onSubmit={handleSubmit((v) => create.mutate(v))}
            >
              <TextField
                control={control}
                name="name"
                label={t('servers.name')}
                description={t('servers.nameHint')}
                placeholder="srv-hn-03"
              />
              <FormField
                control={control}
                name="role_tags"
                label={t('servers.roles')}
                render={(f) => (
                  <div id={f.id} role="group" className="flex flex-wrap gap-4">
                    {ROLES.map((r) => {
                      const v = f.value as Role[];
                      return (
                        <label key={r} className="flex items-center gap-2 text-base">
                          <Checkbox
                            checked={v.includes(r)}
                            onCheckedChange={(c) =>
                              f.onChange(c === true ? [...v, r] : v.filter((x) => x !== r))
                            }
                          />
                          {t(`servers.role.${r}`)}
                        </label>
                      );
                    })}
                  </div>
                )}
              />
              <TextField
                control={control}
                name="ttl_min"
                type="number"
                label={t('servers.ttl')}
                description={t('servers.ttlHint')}
              />
              <Button type="submit" disabled={create.isPending || token !== null}>
                <ServerCog aria-hidden />
                {t('servers.createToken')}
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader title={t('servers.step2')} />
          <CardContent className="flex flex-col gap-4">
            {token === null ? (
              <p className="text-base text-muted">{t('servers.step2Hint')}</p>
            ) : (
              <>
                <p className="text-base">{t('servers.runCommand')}</p>
                <CodeBlock code={token.command} label={t('servers.joinCommand')} />
                <InfoList
                  items={[
                    [
                      t('servers.caPin'),
                      <code key="ca" className="font-mono text-xs break-all">
                        {token.ca_sha256}
                      </code>,
                    ],
                    [
                      t('servers.tokenExpiresLabel'),
                      `${fmt.dateTime(token.expires_at)} (${fmt.rel(token.expires_at)})`,
                    ],
                  ]}
                />
                <p className="text-sm text-muted">{t('servers.tokenOnce')}</p>
                {joined.data ? (
                  <Alert
                    tone="success"
                    title={t('servers.joined', { name: joined.data.name })}
                    action={
                      <AppLink
                        href={`/admin/servers/${joined.data.uuid}`}
                        className={buttonVariants({ size: 'sm' })}
                      >
                        {t('servers.openServer')}
                      </AppLink>
                    }
                  >
                    {joined.data.os} · {joined.data.ip_addresses.at(-1)}
                  </Alert>
                ) : (
                  <div role="status" className="flex items-center gap-2 text-base text-muted">
                    <Loader2 aria-hidden className="size-4 animate-spin" />
                    {t('servers.waiting')}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
