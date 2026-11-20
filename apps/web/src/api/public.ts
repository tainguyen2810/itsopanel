import createClient from 'openapi-fetch';
import type { paths } from './generated/portal/schema';
import { clientOptions } from './http';

/** Route công khai có trong cả Admin và Portal API (không cần đăng nhập). */
type PublicPaths = Pick<paths, '/api/v1/system/health'>;

export const publicApi = createClient<PublicPaths>(clientOptions);
