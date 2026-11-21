import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import { list } from '../api';

const KEY = 'itso.security.server';

function remembered(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Máy chủ đang xem ở các trang cấu hình theo máy chủ (SSH, Fail2ban): API bắt buộc `?server=<uuid>`. Mặc định máy
 * đầu tiên; nhớ lựa chọn trong phiên trình duyệt. `picker` chỉ hiện khi có từ 2 máy chủ.
 */
export function useSecurityServer() {
  const { t } = useTranslation('admin');
  const servers = useQuery({
    queryKey: ['admin', 'servers', 'security-picker'],
    queryFn: () => list('/api/v1/admin/servers'),
  });
  const [chosen, setChosen] = useState(remembered);
  const all = servers.data ?? [];
  const server = all.some((s) => s.uuid === chosen) ? chosen : (all[0]?.uuid ?? '');
  const choose = (v: string) => {
    setChosen(v);
    try {
      sessionStorage.setItem(KEY, v);
    } catch {
      // trình duyệt chặn storage: chỉ nhớ trong trang
    }
  };
  const picker =
    all.length > 1 ? (
      <div className="flex items-center gap-2">
        <Label htmlFor="sec-server" className="whitespace-nowrap">
          {t('sec.server')}
        </Label>
        <Select
          id="sec-server"
          className="min-w-48"
          value={server}
          onValueChange={choose}
          options={all.map((s) => ({ value: s.uuid, label: s.name }))}
        />
      </div>
    ) : undefined;
  return { server, picker, loading: servers.isLoading, error: servers.error };
}
