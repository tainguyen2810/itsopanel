import { setupServer } from 'msw/node';
import { handlers } from './msw';

/** API giả lập cho Vitest (cùng handler với trình duyệt). */
export const demoServer = setupServer(...handlers);
