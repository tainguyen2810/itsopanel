import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/shared/page/PageHeader';
import { FormDialog } from '@/shared/page/FormDialog';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Input } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import { list, send } from '../api';
import { useAction } from '../useAction';
import { ServerNav, useServer } from './common';
import { TerminalView as Terminal, simulate, type Ticket } from '@/shared/hosting/pages/Terminal';

export { simulate };

export default function ServerTerminalPage() {
  const { t } = useTranslation('admin');
  const server = useServer();
  const [mode, setMode] = useState<'root' | 'account'>('account');
  const [account, setAccount] = useState('');
  const [stepUp, setStepUp] = useState(false);
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const accounts = useQuery({
    queryKey: ['admin', 'server', server.id, 'accounts', 'terminal'],
    queryFn: () => list('/api/v1/admin/hosting-accounts', { filters: { server: server.id } }),
  });
  const open = useAction(
    async () => {
      if (mode === 'root') {
        await send('POST', '/api/v1/auth/step-up', { body: { code, method: 'totp' } });
      }
      return send<Ticket>('POST', '/api/v1/admin/terminal/sessions', {
        body:
          mode === 'root'
            ? { mode, server_uuid: server.id }
            : { mode, hosting_account_uuid: account || accounts.data?.[0]?.uuid },
      });
    },
    {
      onSuccess: (r) => {
        setStepUp(false);
        setCode('');
        setTicket(r);
      },
    },
  );
  const host = server.data?.name ?? 'server';

  return (
    <>
      <PageHeader
        nav={<ServerNav current="terminal" />}
        title={t('terminal.title')}
        description={t('terminal.description')}
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4 xl:col-span-2">
          {ticket === null ? (
            <Card>
              <CardHeader title={t('terminal.open')} />
              <CardContent className="flex flex-col gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="term-mode">{t('terminal.mode')}</Label>
                    <Select
                      id="term-mode"
                      value={mode}
                      onValueChange={(v) => setMode(v as typeof mode)}
                      options={[
                        { value: 'account', label: t('terminal.modes.account') },
                        { value: 'root', label: t('terminal.modes.root') },
                      ]}
                    />
                  </div>
                  {mode === 'account' && (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="term-account">{t('terminal.account')}</Label>
                      <Select
                        id="term-account"
                        value={account || accounts.data?.[0]?.uuid || ''}
                        onValueChange={setAccount}
                        options={(accounts.data ?? []).map((a) => ({
                          value: a.uuid,
                          label: a.username,
                        }))}
                      />
                    </div>
                  )}
                </div>
                {mode === 'root' && (
                  <Alert tone="warning" title={t('terminal.rootWarning')}>
                    {t('terminal.rootWarningHint')}
                  </Alert>
                )}
                <div>
                  <Button
                    onClick={() => (mode === 'root' ? setStepUp(true) : open.mutate())}
                    disabled={open.isPending || (mode === 'account' && !accounts.data?.length)}
                  >
                    <SquareTerminal aria-hidden />
                    {t('terminal.connect')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Terminal ticket={ticket} host={host} onClose={() => setTicket(null)} />
          )}
        </div>
        <Card>
          <CardHeader title={t('terminal.policy')} />
          <CardContent>
            <ul className="flex list-disc flex-col gap-2 pl-5 text-base">
              {(['p1', 'p2', 'p3', 'p4', 'p5'] as const).map((k) => (
                <li key={k}>{t(`terminal.policies.${k}`)}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      <FormDialog
        open={stepUp}
        onOpenChange={setStepUp}
        title={t('terminal.stepUp')}
        description={t('terminal.stepUpHint')}
        submitLabel={t('terminal.connect')}
        pending={open.isPending || !/^\d{6}$/.test(code)}
        onSubmit={() => open.mutate()}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="stepup-code">{t('auth.code')}</Label>
          <Input
            id="stepup-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="font-mono tracking-[0.3em]"
          />
        </div>
      </FormDialog>
    </>
  );
}
