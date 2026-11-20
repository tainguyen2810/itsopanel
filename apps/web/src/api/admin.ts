import createClient from 'openapi-fetch';
import type { components, paths } from './generated/admin/schema';
import { clientOptions } from './http';

/** Client Admin API, type sinh từ contracts/openapi/itso-admin-v1.yaml. Chỉ dùng trong entry admin. */
export const adminApi = createClient<paths>(clientOptions);

export type AdminSchemas = components['schemas'];
export type SystemStatus = AdminSchemas['SystemStatus'];
