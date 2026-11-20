import { useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { send } from '@/shared/api/realm';
import { useAction } from '@/shared/api/useAction';
import { useActiveAccounts, useFeatures } from '@/shared/hosting/pages/common';
import { TerminalView, type Ticket } from '@/shared/hosting/pages/Terminal';
import { PageHeader } from '@/shared/page/PageHeader';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';

/** Terminal (Portal): shell của account mình, chỉ khi gói có SSH; luôn chạy dưới UID account. */
export default function TerminalPage() {
  const { t } = useTranslation('admin');
  const { accounts, options } = useActiveAccounts();
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const account = picked ?? accounts[0]?.uuid;
  const features = useFeatures(account);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const open = useAction(
    () =>
      send<Ticket>('POST', '/terminal/sessions', {
        body: { mode: 'account', hosting_account_uuid: account },
      }),
    { onSuccess: setTicket },
  );
  const noSsh = features.data !== undefined && !features.data.ssh_allowed;
  return (
    <>
      <PageHeader title={t('pt.terminal')} description={t('pt.terminalHint')} />
      {ticket ? (
        <TerminalView ticket={ticket} host={t('pt.terminalHost')} onClose={() => setTicket(null)} />
      ) : (
        <Card>
          <CardHeader title={t('terminal.open')} />
          <CardContent className="flex flex-col gap-4">
            <div className="flex max-w-sm flex-col gap-1.5">
              <Label htmlFor="term-account">{t('terminal.account')}</Label>
              <Select
                id="term-account"
                value={account ?? ''}
                onValueChange={setPicked}
                options={options}
                placeholder={t('sites.pickAccount')}
              />
            </div>
            {noSsh && (
              <Alert tone="warning" title={t('pt.noSsh')}>
                {t('pt.noSshHint')}
              </Alert>
            )}
            <div>
              <Button
                onClick={() => open.mutate()}
                disabled={!account || noSsh || features.isPending || open.isPending}
              >
                <SquareTerminal aria-hidden />
                {t('terminal.connect')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
