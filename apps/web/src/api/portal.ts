import createClient from 'openapi-fetch';
import type { components, paths } from './generated/portal/schema';
import { clientOptions } from './http';

/** Client Portal API, type sinh từ contracts/openapi/itso-portal-v1.yaml. Không chứa route `/admin/`. */
export const portalApi = createClient<paths>(clientOptions);

export type PortalSchemas = components['schemas'];
export type Health = PortalSchemas['Health'];
