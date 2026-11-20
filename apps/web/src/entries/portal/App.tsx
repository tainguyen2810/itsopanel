import { HealthRow } from '@/shared/components/HealthRow';
import { ScaffoldPage } from '@/shared/components/ScaffoldPage';

/**
 * Trang tạm của Portal: chỉ health API.
 * Chi tiết agent/hạ tầng là thông tin Admin-only, không lộ qua portal (realm separation).
 */
export function App() {
  return (
    <ScaffoldPage title="User Hosting Portal" subtitle="Trạng thái môi trường dev">
      <HealthRow />
    </ScaffoldPage>
  );
}
